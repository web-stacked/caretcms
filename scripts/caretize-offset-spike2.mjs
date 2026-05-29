// Spike v2: same probe, but operate on a UTF-8 Buffer because @astrojs/compiler
// reports BYTE offsets, not JS-string (UTF-16) indices. If this hypothesis is
// right, the failures from v1 (all in files containing — and ─ multibyte chars)
// should disappear.

import { parse } from "@astrojs/compiler";
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type === "element" || node.type === "component" || node.type === "custom-element") visit(node);
  if (Array.isArray(node.children)) for (const c of node.children) walk(c, visit);
}

const GT = 0x3e, LT = 0x3c, SLASH = 0x2f, LBRACE = 0x7b, RBRACE = 0x7d;
const DQUOTE = 0x22, SQUOTE = 0x27, BACKTICK = 0x60;

// buf: Buffer (UTF-8). startOffset: byte offset of the '<'.
function findOpenTagEnd(buf, startOffset) {
  let i = startOffset;
  if (buf[i] !== LT) return null;
  i++;
  let brace = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (brace === 0 && (b === DQUOTE || b === SQUOTE || b === BACKTICK)) {
      const q = b; i++;
      while (i < buf.length && buf[i] !== q) i++;
      i++; continue;
    }
    if (b === LBRACE) { brace++; i++; continue; }
    if (b === RBRACE) { brace = Math.max(0, brace - 1); i++; continue; }
    if (brace === 0 && b === GT) {
      const selfClosing = buf[i - 1] === SLASH;
      return { insertAt: selfClosing ? i - 1 : i, selfClosing, gtOffset: i };
    }
    i++;
  }
  return null;
}

let total = 0, resolved = 0, mismatch = 0;
const fails = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const buf = Buffer.from(source, "utf8");
  const { ast } = await parse(source, { position: true });
  const els = [];
  walk(ast, (n) => els.push(n));
  for (const node of els) {
    total++;
    const start = node.position?.start?.offset;
    if (typeof start !== "number") { fails.push(`${file} <${node.name}> no-offset`); continue; }
    const found = findOpenTagEnd(buf, start);
    if (!found) { fails.push(`${file} <${node.name}> no-'>' @${start}`); continue; }
    resolved++;
    const openTag = buf.slice(start, found.gtOffset + 1).toString("utf8");
    if (!openTag.startsWith("<" + node.name)) { mismatch++; fails.push(`${file} <${node.name}> MISMATCH: ${openTag.slice(0,40)}`); }
  }
}

console.log("=== v2 (byte-offset) summary ===");
console.log(`elements:  ${total}`);
console.log(`resolved:  ${resolved}`);
console.log(`mismatch:  ${mismatch}`);
console.log(`fails:     ${fails.length}`);
for (const f of fails) console.log("  ", f);

// Round-trip proof on a multibyte file (about.astro) — splice onto a real
// content element, re-parse, confirm validity + byte-reversibility.
console.log("\n=== round-trip on a multibyte file ===");
const file = files.find((f) => f.includes("about.astro")) ?? files[0];
const source = readFileSync(file, "utf8");
const buf = Buffer.from(source, "utf8");
const { ast } = await parse(source, { position: true });
const els = [];
walk(ast, (n) => els.push(n));
// first <h2> (a real headline in about.astro)
const target = els.find((n) => n.name === "h2") ?? els.find((n) => ["h1","p","span"].includes(n.name));
const start = target.position.start.offset;
const found = findOpenTagEnd(buf, start);
const attr = Buffer.from(' data-caret="spike::probe::x"', "utf8");
const out = Buffer.concat([buf.slice(0, found.insertAt), attr, buf.slice(found.insertAt)]);
const outStr = out.toString("utf8");
let ok = true, attrPresent = false;
try {
  const re = await parse(outStr, { position: true });
  const reEls = []; walk(re.ast, (n) => reEls.push(n));
  attrPresent = reEls.some((n) => n.name === target.name && n.attributes?.some((a) => a.name === "data-caret"));
} catch (e) { ok = false; console.log("reparse threw:", e.message); }
const restored = Buffer.concat([out.slice(0, found.insertAt), out.slice(found.insertAt + attr.length)]);
console.log(`file:            ${file}`);
console.log(`target:          <${target.name}>`);
console.log(`spliced tag:     ${out.slice(start, found.gtOffset + 1 + attr.length).toString("utf8")}`);
console.log(`re-parses ok:    ${ok}`);
console.log(`attr present:    ${attrPresent}`);
console.log(`byte-reversible: ${restored.equals(buf)}`);
