/**
 * Tier-4 prop hoisting — a guarded REWRITE (not pure insertion).
 *
 * The most common pattern caretize couldn't touch is a static string passed to a
 * shared component as a prop:
 *
 *   <PageHero title="ABOUT US" description="Since 2010 …" />
 *
 * The text never appears as a tag-able text leaf (it's an attribute on a
 * component), and `data-caret` can't ride a component boundary. The fix is to
 * hoist each literal into an `editable()` frontmatter const and reference it:
 *
 *   const pageHeroTitle = await editable("pages::about::title", "ABOUT US");
 *   …
 *   <PageHero title={pageHeroTitle} description={pageHeroDesc} />
 *
 * Unlike the other tiers this DELETES bytes (the attribute literal), so it can't
 * use the subsequence gate. Instead it is verified by an INVERSE check: undo
 * every edit (swap the reference back to the literal, strip the const lines) and
 * assert the result is byte-identical to the input — proving the only changes
 * were the intended hoists. A hand-off is rewritten only on positive proof the
 * child renders the prop as text (reusing the Tier-2 cross-file verifier), and
 * only when the exact `prop="value"` token occurs exactly once (unambiguous).
 */

import { parseAstro, walkTags, type AstroNode, type TagNode } from "./parse.js";
import { deriveScope, isValidField, slugifyText } from "./name.js";
import { resolveComponentImport } from "./resolve.js";
import { propLocalName, type FileReader } from "./props.js";
import { classifyConstUsage } from "./usage.js";
import { frontmatterRange } from "./frontmatter.js";
import { IMPORT_LINE, IMPORT_RE } from "./wrap.js";

/** One prop literal to hoist, with the exact tokens needed to apply + invert. */
export interface HoistProp {
  propName: string;
  literalValue: string;
  key: string;
  constName: string;
  isRich: boolean;
  /** Exact source token being replaced, e.g. `title="ABOUT US"`. */
  attrBefore: string;
  /** Replacement token, e.g. `title={pageHeroTitle}`. */
  attrAfter: string;
  /** Exact text inserted into frontmatter (leading newline included). */
  constInsert: string;
}

export interface PropHoistTarget {
  componentName: string;
  props: HoistProp[];
}

export interface HoistResult {
  output: string;
  ok: boolean;
  reason?: string;
  propsRewritten: number;
  constsDeclared: string[];
  /** True when this transform added the `editable` import. */
  addedImport: boolean;
}

const RICH_RE = (local: string) =>
  new RegExp(`set:html\\s*=\\s*\\{[^}]*\\b${local}\\b[^}]*\\}`);

function ucFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** camelCase identifier from parts, e.g. ["PageHero","title"] → "pageHeroTitle". */
function camelIdent(parts: string[]): string {
  const words = parts.flatMap((p) => p.split(/[^A-Za-z0-9]+/)).filter(Boolean);
  if (words.length === 0) return "field";
  return words
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : ucFirst(w)))
    .join("");
}

function uniquify(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/** Existing frontmatter binding names, so hoisted consts never shadow one. */
function declaredNames(fmText: string): Set<string> {
  const set = new Set<string>();
  const re = /\b(?:const|let|var|import)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmText))) set.add(m[1]);
  return set;
}

/** Existing data-caret field segments in the file, so keys stay unique. */
function usedFields(source: string): Set<string> {
  const set = new Set<string>();
  const re = /data-caret(?:-rich)?="[^"]*::([A-Za-z0-9_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) set.add(m[1]);
  return set;
}

/** The exact `name="value"` (or single-quoted) token, if it occurs exactly once. */
function uniqueAttrToken(source: string, name: string, value: string): string | null {
  for (const q of ['"', "'"]) {
    if (value.includes(q)) continue;
    const tok = `${name}=${q}${value}${q}`;
    const first = source.indexOf(tok);
    if (first >= 0 && source.indexOf(tok, first + tok.length) < 0) return tok;
  }
  return null;
}

/**
 * Detect prop-hoist targets: component invocations with static string props
 * whose child provably renders them as text. `readFile` resolves sibling files.
 */
export async function detectPropHoistTargets(
  source: string,
  relPath: string,
  readFile: FileReader,
  root?: AstroNode,
): Promise<PropHoistTarget[]> {
  const scoped = deriveScope(relPath);
  if ("skip" in scoped) return [];
  const { collection, id } = scoped.scope;

  const fm = frontmatterRange(source);
  if (!fm) return [];
  const fmText = source.slice(fm.start, fm.end);

  const ast = root ?? (await parseAstro(source));

  const usedConsts = declaredNames(fmText);
  const fields = usedFields(source);

  // Cache child source + its parsed AST across repeated component uses.
  const childCache = new Map<string, { src: string; ast: AstroNode } | null>();
  const readChild = async (rel: string): Promise<{ src: string; ast: AstroNode } | null> => {
    if (!childCache.has(rel)) {
      const src = readFile(rel);
      childCache.set(rel, src === null ? null : { src, ast: await parseAstro(src) });
    }
    return childCache.get(rel) ?? null;
  };

  /** Does the child render `prop` purely as text (incl. set:html), no re-handoff? */
  const childTextSafe = (child: { src: string; ast: AstroNode }, prop: string): boolean => {
    const local = propLocalName(child.src, prop);
    if (!local) return false;
    return classifyConstUsage(child.ast, local, {
      componentHandoffUnsafe: true,
      htmlDirectivesSafe: true,
    }).safe;
  };

  const targets: PropHoistTarget[] = [];
  const componentNodes: TagNode[] = [];
  walkTags(ast, (node) => {
    if (node.type === "component") componentNodes.push(node);
  });

  for (const node of componentNodes) {
    const childRel = resolveComponentImport(source, node.name, relPath);
    const child = childRel ? await readChild(childRel) : null;
    if (!child) continue;

    const props: HoistProp[] = [];
    for (const attr of node.attributes) {
      if (attr.kind !== "quoted") continue;
      const value = attr.value ?? "";
      if (value.trim() === "") continue;
      if (!isValidField(attr.name) && !slugifyText(attr.name)) continue;

      // Positive proof: the child renders this prop as text (no native-attr, no
      // re-handoff). set:html counts as text (stega-safe content sink).
      if (!childTextSafe(child, attr.name)) continue;

      // Locate an unambiguous source token; skip if absent/duplicated.
      const attrBefore = uniqueAttrToken(source, attr.name, value);
      if (!attrBefore) continue;

      const local = propLocalName(child.src, attr.name);
      const isRich = local ? RICH_RE(local).test(child.src) : false;

      const baseField = (isValidField(attr.name) ? attr.name : slugifyText(attr.name))!;
      const field = uniquify(baseField, fields);
      const constName = uniquify(camelIdent([node.name, attr.name]), usedConsts);
      const key = `${collection}::${id}::${field}`;
      const constInsert = `\nconst ${constName} = await editable(${JSON.stringify(key)}, ${JSON.stringify(value)});`;

      props.push({
        propName: attr.name,
        literalValue: value,
        key,
        constName,
        isRich,
        attrBefore,
        attrAfter: `${attr.name}={${constName}}`,
        constInsert,
      });
    }
    if (props.length) targets.push({ componentName: node.name, props });
  }

  return targets;
}

/** Apply the hoist rewrite. Self-locating: finds each `attrBefore` token by content. */
export function hoistPropLiterals(source: string, targets: PropHoistTarget[]): HoistResult {
  const base: HoistResult = {
    output: source, ok: true, propsRewritten: 0, constsDeclared: [], addedImport: false,
  };
  const flat = targets.flatMap((t) => t.props);
  if (flat.length === 0) return base;

  let output = source;

  // 1. Rewrite each attribute literal → expression reference (template region).
  for (const p of flat) {
    if (!output.includes(p.attrBefore)) {
      return { ...base, ok: false, reason: `attr token not found: ${p.attrBefore}` };
    }
    output = output.replace(p.attrBefore, p.attrAfter);
  }

  // 2. Insert the editable() consts at the end of the frontmatter, and the
  //    import at the top (once). Recompute the range on the rewritten source.
  const fm = frontmatterRange(output);
  if (!fm) return { ...base, ok: false, reason: "no frontmatter block" };

  const addedImport = !IMPORT_RE.test(output);
  const constBlock = flat.map((p) => p.constInsert).join("");
  output =
    output.slice(0, fm.start) +
    (addedImport ? `${IMPORT_LINE}\n` : "") +
    output.slice(fm.start, fm.end) +
    constBlock +
    output.slice(fm.end);

  return {
    output,
    ok: true,
    propsRewritten: flat.length,
    constsDeclared: flat.map((p) => p.constName),
    addedImport,
  };
}

/**
 * Inverse gate: undo every hoist edit on `output` and assert the result is
 * byte-identical to `intermediate` (the source the hoist was applied to). This
 * proves the ONLY changes were the intended hoists — no collateral edits.
 */
export function verifyHoistResult(
  intermediate: string,
  output: string,
  targets: PropHoistTarget[],
  addedImport: boolean,
): boolean {
  let restored = output;
  if (addedImport) restored = restored.replace(`${IMPORT_LINE}\n`, "");
  for (const p of targets.flatMap((t) => t.props)) {
    if (!restored.includes(p.constInsert)) return false;
    restored = restored.replace(p.constInsert, "");
    if (!restored.includes(p.attrAfter)) return false;
    restored = restored.replace(p.attrAfter, p.attrBefore);
  }
  return restored === intermediate;
}
