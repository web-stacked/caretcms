/**
 * Tier-3 editable() wrapping for IMPORTED data — PURE INSERTION.
 *
 * A very common Astro pattern keeps list content in a data file and renders it
 * with `.map()`:
 *
 *   import faqs from "./data/faqs.json";
 *   …
 *   {faqs.map((f) => <details>{f.question}…</details>)}
 *
 * caretize's Tier-1 wrap only sees inline-literal consts (`const x = [...]`), so
 * this content was previously left un-editable. Tier-3 makes it editable WITHOUT
 * moving any code: it suffixes the import binding and rebinds the original name
 * to an `editable()` wrap of it —
 *
 *   import faqsRaw from "./data/faqs.json";
 *   const faqs = await editable("pages::home::faqs", faqsRaw);
 *
 * Every original character survives in order (the import binding only GAINS a
 * suffix; a new const line is inserted), so the result is a provable pure
 * insertion — the same subsequence safety contract as Tier-1. The `.map()`
 * consumer is untouched and now reads the stega-encoded, click-to-edit value.
 */

import { deriveScope, isValidField, slugifyText } from "./name.js";
import { parseAstro, type AstroNode } from "./parse.js";
import { classifyConstUsage } from "./usage.js";
import {
  frontmatterRange,
  importBindingNames,
  namedImportBindingNames,
  type ImportKind,
} from "./frontmatter.js";
import { escapeRe, identRefRe, isIdentifier } from "./identifiers.js";
import { IMPORT_LINE, IMPORT_RE, type WrapResult, type WrapTarget } from "./wrap.js";

/** An import binding the wrapper could target, before safety is verified. */
export interface ImportWrapCandidate {
  /** The original local binding, e.g. `faqs`. */
  varName: string;
  /** Binding key, e.g. `pages::home::faqs`. */
  key: string;
  /** The import specifier, e.g. `./data/faqs.json` (for display). */
  specifier: string;
  /** Whether the source is a `.json` data file or a `.js`/`.ts` module. */
  importKind: ImportKind;
}

/** Pick a non-colliding suffixed name for the raw (pre-editable) import binding. */
function rawNameFor(source: string, varName: string): string | null {
  for (const suffix of ["Raw", "Source", "Data"]) {
    const candidate = `${varName}${suffix}`;
    // identRefRe: $-aware boundaries + escaping (`\b$faqsRaw\b` never matches).
    if (!identRefRe(candidate).test(source)) return candidate;
  }
  return null;
}

/**
 * Rebind an imported `varName` to `await editable("<key>", <varName>Raw)` and
 * ensure the import is present. Pure insertion: the import binding gains a
 * suffix and a new const line is inserted; nothing is deleted.
 */
export function wrapImport(source: string, varName: string, key: string): WrapResult {
  if (!isIdentifier(varName)) {
    return { output: source, ok: false, reason: `invalid identifier: ${varName}` };
  }

  const fm = frontmatterRange(source);
  if (!fm) return { output: source, ok: false, reason: "no frontmatter block" };

  const fmText = source.slice(fm.start, fm.end);

  // Idempotent: bail if this binding is already an editable() rebind.
  if (new RegExp(`\\bconst\\s+${escapeRe(varName)}\\s*=\\s*await\\s+editable\\s*\\(`).test(fmText)) {
    return { output: source, ok: true, alreadyWrapped: true };
  }

  const importRe = new RegExp(
    `\\bimport\\s+(?!type\\b)(${escapeRe(varName)})\\s+from\\s*['"][^'"]+['"]`,
  );
  const m = importRe.exec(fmText);
  if (!m) {
    return { output: source, ok: false, reason: `default import of ${varName} not found` };
  }

  const rawName = rawNameFor(source, varName);
  if (!rawName) {
    return { output: source, ok: false, reason: `could not pick a free name for ${varName}` };
  }

  // Offset just past the binding identifier (insert the suffix here).
  const kw = /^import\s+/.exec(m[0])![0];
  const identEndRel = m.index + kw.length + varName.length;
  // Offset just past the import statement, swallowing an optional `;`.
  let stmtEndRel = m.index + m[0].length;
  if (fmText[stmtEndRel] === ";") stmtEndRel++;

  const identEndAbs = fm.start + identEndRel;
  const stmtEndAbs = fm.start + stmtEndRel;

  const suffix = rawName.slice(varName.length); // e.g. "Raw"
  const constLine = `\nconst ${varName} = await editable(${JSON.stringify(key)}, ${rawName});`;

  // Two pure insertions, applied left-to-right via slicing: the binding gains
  // `suffix`, and a new const line follows the import statement.
  let output =
    source.slice(0, identEndAbs) +
    suffix +
    source.slice(identEndAbs, stmtEndAbs) +
    constLine +
    source.slice(stmtEndAbs);

  if (!IMPORT_RE.test(source)) {
    output = output.slice(0, fm.start) + IMPORT_LINE + "\n" + output.slice(fm.start);
  }

  return { output, ok: true };
}

/**
 * Rebind a NAMED imported `varName` to `await editable("<key>", <varName>Raw)`,
 * renaming the binding inside the destructure to the raw name. Pure insertion:
 * the destructure gains ` as <raw>` after the local name and a new const line
 * follows the statement; nothing is deleted.
 *
 *   import { services } from "../data/site.ts";
 *     →  import { services as servicesRaw } from "../data/site.ts";
 *        const services = await editable("…", servicesRaw);
 *
 * Multi-binding-safe: called once per binding, threading the mutated source
 * forward. After `services` is renamed, the statement reads
 * `{ services as servicesRaw, team }`; the next call locates `team` by
 * whole-identifier match, never inside `servicesRaw`.
 */
export function wrapNamedImport(source: string, varName: string, key: string): WrapResult {
  if (!isIdentifier(varName)) {
    return { output: source, ok: false, reason: `invalid identifier: ${varName}` };
  }

  const fm = frontmatterRange(source);
  if (!fm) return { output: source, ok: false, reason: "no frontmatter block" };

  const fmText = source.slice(fm.start, fm.end);

  // Idempotent: bail if this binding is already an editable() rebind.
  if (new RegExp(`\\bconst\\s+${escapeRe(varName)}\\s*=\\s*await\\s+editable\\s*\\(`).test(fmText)) {
    return { output: source, ok: true, alreadyWrapped: true };
  }

  // Locate the named-import statement that contains `varName` as a whole
  // identifier inside its `{ … }` (lookbehind/ahead keep it off `varNameRaw`).
  const stmtRe = new RegExp(
    `\\bimport\\s+(?!type\\b)(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?` +
      `\\{[^}]*(?<![\\w$])${escapeRe(varName)}(?![\\w$])[^}]*\\}\\s+from\\s*['"][^'"]+['"]`,
  );
  const m = stmtRe.exec(fmText);
  if (!m) {
    return { output: source, ok: false, reason: `named import of ${varName} not found` };
  }

  // Position of the binding within the matched statement (first whole-word hit;
  // the `{ … }` precedes the specifier, so this lands inside the destructure).
  const inner = identRefRe(varName).exec(m[0]);
  if (!inner) {
    return { output: source, ok: false, reason: `could not locate ${varName} in import` };
  }

  const rawName = rawNameFor(source, varName);
  if (!rawName) {
    return { output: source, ok: false, reason: `could not pick a free name for ${varName}` };
  }

  const identEndRel = m.index + inner.index + varName.length;
  let stmtEndRel = m.index + m[0].length;
  if (fmText[stmtEndRel] === ";") stmtEndRel++;

  const identEndAbs = fm.start + identEndRel;
  const stmtEndAbs = fm.start + stmtEndRel;

  const aliasSuffix = ` as ${rawName}`;
  const constLine = `\nconst ${varName} = await editable(${JSON.stringify(key)}, ${rawName});`;

  // Two pure insertions: the destructure binding gains ` as <raw>`, and a new
  // const line follows the import statement.
  let output =
    source.slice(0, identEndAbs) +
    aliasSuffix +
    source.slice(identEndAbs, stmtEndAbs) +
    constLine +
    source.slice(stmtEndAbs);

  if (!IMPORT_RE.test(source)) {
    output = output.slice(0, fm.start) + IMPORT_LINE + "\n" + output.slice(fm.start);
  }

  return { output, ok: true };
}

/**
 * Detect Tier-3 candidates: DEFAULT imports of a `.json`/module data file that
 * are `.map()`/`.flatMap()`'d in the template. Key is derived from the file's
 * scope (`collection::id`) plus the binding name as the field.
 */
export function detectImportWrapCandidates(
  source: string,
  relPath: string,
): ImportWrapCandidate[] {
  return detectMappedImportCandidates(source, relPath, importBindingNames);
}

/**
 * Tier-3 named variant: NAMED imports (`import { services } from "./data.ts"`)
 * `.map()`'d in the template. Same scope/key/idempotency logic as the default
 * detector — only the binding resolver differs ({@link namedImportBindingNames}).
 */
export function detectNamedImportWrapCandidates(
  source: string,
  relPath: string,
): ImportWrapCandidate[] {
  return detectMappedImportCandidates(source, relPath, namedImportBindingNames);
}

/** Shared core: resolve import bindings via `resolve`, keep the `.map()`'d ones. */
function detectMappedImportCandidates(
  source: string,
  relPath: string,
  resolve: (fmText: string) => Map<string, { specifier: string; importKind: ImportKind }>,
): ImportWrapCandidate[] {
  const fm = frontmatterRange(source);
  if (!fm) return [];
  const fmText = source.slice(fm.start, fm.end);
  const template = source.slice(fm.end);

  const imports = resolve(fmText);
  if (imports.size === 0) return [];

  // Of the imported bindings, the ones actually iterated in the template.
  const mapped = new Set<string>();
  const mapRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:map|flatMap)\b/g;
  let mm: RegExpExecArray | null;
  while ((mm = mapRe.exec(template))) {
    if (imports.has(mm[1])) mapped.add(mm[1]);
  }
  if (mapped.size === 0) return [];

  const scoped = deriveScope(relPath);
  if ("skip" in scoped) return [];
  const { collection, id } = scoped.scope;

  const candidates: ImportWrapCandidate[] = [];
  for (const varName of mapped) {
    // Already rebound on a prior run → not a candidate.
    if (new RegExp(`\\bconst\\s+${escapeRe(varName)}\\s*=\\s*await\\s+editable\\s*\\(`).test(fmText)) {
      continue;
    }
    const field = isValidField(varName) ? varName : slugifyText(varName);
    if (!field) continue;
    const meta = imports.get(varName)!;
    candidates.push({
      varName,
      key: `${collection}::${id}::${field}`,
      specifier: meta.specifier,
      importKind: meta.importKind,
    });
  }
  return candidates;
}

/**
 * Safety-checked Tier-3 detection: import-backed candidates minus any whose
 * mapped fields flow into a native-element attribute (where `editable()`'s stega
 * encoding would corrupt an href/src/class/…). Mirrors `detectWrapTargetsSafe`.
 */
export async function detectImportWrapTargetsSafe(
  source: string,
  relPath: string,
  root?: AstroNode,
): Promise<WrapTarget[]> {
  const candidates = detectImportWrapCandidates(source, relPath);
  if (candidates.length === 0) return [];
  const ast = root ?? (await parseAstro(source));
  return candidates
    .filter((c) => classifyConstUsage(ast, c.varName).safe)
    .map((c) => ({ varName: c.varName, key: c.key, origin: "import" as const }));
}

/**
 * Safety-checked Tier-3 named-import detection: the named counterpart to
 * {@link detectImportWrapTargetsSafe}. Same `classifyConstUsage` gate — a named
 * import whose fields flow into a native-element attribute stays UNSAFE and
 * unwrapped. Targets carry `origin: "named-import"` so `run.ts` routes them to
 * {@link wrapNamedImport}.
 */
export async function detectNamedImportWrapTargetsSafe(
  source: string,
  relPath: string,
  root?: AstroNode,
): Promise<WrapTarget[]> {
  const candidates = detectNamedImportWrapCandidates(source, relPath);
  if (candidates.length === 0) return [];
  const ast = root ?? (await parseAstro(source));
  return candidates
    .filter((c) => classifyConstUsage(ast, c.varName).safe)
    .map((c) => ({ varName: c.varName, key: c.key, origin: "named-import" as const }));
}
