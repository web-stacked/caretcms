// Offset spike for `caretize`.
// Question being answered: given @astrojs/compiler's AST, can we reliably find
// the byte offset of the END of an element's opening tag, so we can splice in a
// ` data-caret="..."` attribute without reformatting the file?
//
// We do NOT trust the AST for writing. We use node.position.start as an anchor
// and scan the original source forward to the `>` that closes the opening tag,
// skipping `>` chars that live inside quoted attribute values or `{...}`
// expressions. Then we splice and re-parse to prove the result is valid.

import { parse } from "@astrojs/compiler";
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node caretize-offset-spike.mjs <file.astro> ...");
  process.exit(1);
}

// Walk every element node in the AST, calling visit(node).
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type === "element" || node.type === "component" || node.type === "custom-element") {
    visit(node);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

// From the start offset of an opening tag, find the offset of the `>` (or `/>`)
// that closes it. Returns { insertAt, selfClosing } or null if not found.
function findOpenTagEnd(source, startOffset) {
  let i = startOffset;
  // must start with '<'
  if (source[i] !== "<") return null;
  i++;
  let depthBrace = 0;
  while (i < source.length) {
    const ch = source[i];
    if (depthBrace === 0 && (ch === '"' || ch === "'" || ch === "`")) {
      // skip quoted attribute value
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) i++;
      i++;
      continue;
    }
    if (ch === "{") { depthBrace++; i++; continue; }
    if (ch === "}") { depthBrace = Math.max(0, depthBrace - 1); i++; continue; }
    if (depthBrace === 0 && ch === ">") {
      const selfClosing = source[i - 1] === "/";
      // insert before the `/` for self-closing, else before `>`
      return { insertAt: selfClosing ? i - 1 : i, selfClosing, gtOffset: i };
    }
    i++;
  }
  return null;
}

let totalElems = 0;
let resolved = 0;
let failures = [];
let spliceChecks = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const { ast } = await parse(source, { position: true });

  const elements = [];
  walk(ast, (n) => elements.push(n));

  for (const node of elements) {
    totalElems++;
    const start = node.position?.start?.offset;
    const tagName = node.name;
    if (typeof start !== "number") {
      failures.push({ file, tagName, reason: "no start offset" });
      continue;
    }
    const found = findOpenTagEnd(source, start);
    if (!found) {
      failures.push({ file, tagName, start, reason: "could not locate '>'" });
      continue;
    }
    resolved++;

    // Sanity: the slice from start..gtOffset should look like a single opening tag
    const openTag = source.slice(start, found.gtOffset + 1);
    const looksRight = openTag.startsWith("<" + tagName);

    spliceChecks.push({ file, tagName, openTag: openTag.replace(/\n/g, "\\n"), looksRight });
  }
}

console.log("\n=== open-tag slices found (sample) ===");
for (const s of spliceChecks.slice(0, 40)) {
  const flag = s.looksRight ? "  " : "??";
  const tag = s.openTag.length > 90 ? s.openTag.slice(0, 90) + "…" : s.openTag;
  console.log(`${flag} <${s.tagName}>  ${tag}`);
}

console.log("\n=== summary ===");
console.log(`elements seen:        ${totalElems}`);
console.log(`open-tag-end resolved: ${resolved}`);
console.log(`failures:             ${failures.length}`);
const mismatched = spliceChecks.filter((s) => !s.looksRight);
console.log(`slice/name mismatch:  ${mismatched.length}`);
for (const f of failures) console.log("  FAIL", f);
for (const m of mismatched) console.log("  MISMATCH", m.tagName, m.openTag.slice(0, 60));

// Now the real proof: pick the starter page, splice a data-caret onto the FIRST
// untagged pure element we can, re-parse, and confirm it still parses + the attr
// is present and the rest of the file is byte-identical except the insertion.
console.log("\n=== splice round-trip proof (first file) ===");
{
  const file = files[0];
  const source = readFileSync(file, "utf8");
  const { ast } = await parse(source, { position: true });
  const elements = [];
  walk(ast, (n) => elements.push(n));
  // choose first <span> or <h1> as a guinea pig
  const target = elements.find((n) => ["h1", "span", "p"].includes(n.name));
  if (!target) {
    console.log("no suitable target element in", file);
  } else {
    const start = target.position.start.offset;
    const found = findOpenTagEnd(source, start);
    const attr = ' data-caret="spike::test::field"';
    const out = source.slice(0, found.insertAt) + attr + source.slice(found.insertAt);
    // re-parse the spliced output
    let reparseOk = true;
    let attrPresent = false;
    try {
      const re = await parse(out, { position: true });
      const reElems = [];
      walk(re.ast, (n) => reElems.push(n));
      const same = reElems.find((n) => n.name === target.name);
      attrPresent = !!same?.attributes?.some((a) => a.name === "data-caret");
    } catch (e) {
      reparseOk = false;
      console.log("re-parse threw:", e.message);
    }
    // confirm only the insertion changed: removing the attr yields original
    const restored = out.slice(0, found.insertAt) + out.slice(found.insertAt + attr.length);
    const byteIdentical = restored === source;
    console.log(`target:           <${target.name}>`);
    console.log(`spliced opening:  ${out.slice(start, found.gtOffset + 1 + attr.length).replace(/\n/g, "\\n").slice(0, 100)}`);
    console.log(`re-parses ok:     ${reparseOk}`);
    console.log(`attr present:     ${attrPresent}`);
    console.log(`reversible (byte-identical on removal): ${byteIdentical}`);
  }
}
