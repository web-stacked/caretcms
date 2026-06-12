/**
 * Tier-1 editable() wrapping — PURE INSERTION.
 *
 * Wraps a frontmatter `const`/`let`/`var` initializer with
 * `await editable('key', …)` and inserts the import, WITHOUT moving any code:
 * the original initializer is preserved verbatim between two inserted spans, so
 * the transform is provably reversible (strip the inserted text → original
 * restored) — the same safety contract as caretize's attribute insertion.
 *
 *   const services = ['a', 'b'];
 *     →  const services = await editable("pages::home::services", ['a', 'b']);
 *   (+ `import { editable } from '@caretcms/core';` at the top of frontmatter)
 *
 * Restructuring cases (an inline array literal inside JSX that must be hoisted
 * to frontmatter) are intentionally NOT handled here — that breaks pure
 * insertion and belongs to a separate, opt-in migrator.
 */

import { deriveScope, isValidField, slugifyText } from "./name.js";
import { parseAstro, type AstroNode } from "./parse.js";
import { classifyConstUsage } from "./usage.js";
import { frontmatterRange, literalConstNames } from "./frontmatter.js";
import { escapeRe, isIdentifier } from "./identifiers.js";

/** The `editable()` import line + a detector for it, shared with import-wrap.ts. */
export const IMPORT_LINE = `import { editable } from '@caretcms/core';`;
export const IMPORT_RE =
  /import\s*\{[^}]*\beditable\b[^}]*\}\s*from\s*['"]@caretcms\/core['"]/;

/** A literal const the wrapper could target, before its provenance is known. */
export interface WrapCandidate {
  /** Frontmatter const/let/var to wrap. */
  varName: string;
  /** Binding key, e.g. `pages::home::services`. */
  key: string;
}

/**
 * How a wrap target was found:
 *  - `loop`   — a same-file literal const iterated in the template (Tier-1)
 *  - `prop`   — a literal const passed to a component that renders it as text (Tier-2)
 *  - `import` — a default JSON/module import iterated in the template (Tier-3)
 */
export type WrapOrigin = "loop" | "prop" | "import";

/** A safety-verified wrap target, tagged with how it was found. */
export interface WrapTarget extends WrapCandidate {
  origin: WrapOrigin;
}

export interface WrapResult {
  output: string;
  ok: boolean;
  /** Reason when ok === false. */
  reason?: string;
  /** True when the source already had the wrap (no-op, idempotent). */
  alreadyWrapped?: boolean;
}

/**
 * Given the offset of `=`, return the offset just past the initializer
 * expression by balancing brackets and skipping strings. Stops at a `;` or
 * newline encountered at bracket-depth 0.
 */
function initializerEnd(source: string, eq: number, limit: number): number | null {
  let i = eq + 1;
  while (i < limit && /\s/.test(source[i])) i++;
  if (i >= limit) return null;

  let depth = 0;
  let quote: string | null = null;
  for (; i < limit; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") depth--;
    else if (depth === 0 && (c === ";" || c === "\n")) return i;
  }
  return depth === 0 ? limit : null;
}

/**
 * Wrap the initializer of `const <varName> = …` in the frontmatter with
 * `await editable('<key>', …)` and ensure the import is present. Pure insertion.
 */
export function wrapConst(source: string, varName: string, key: string): WrapResult {
  if (!isIdentifier(varName)) {
    return { output: source, ok: false, reason: `invalid identifier: ${varName}` };
  }

  const fm = frontmatterRange(source);
  if (!fm) return { output: source, ok: false, reason: "no frontmatter block" };

  const fmText = source.slice(fm.start, fm.end);
  // Escaped + $-aware closing boundary (\b never closes a name ending in $).
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(varName)}(?![\\w$])`);
  const m = declRe.exec(fmText);
  if (!m) {
    return { output: source, ok: false, reason: `declaration of ${varName} not found in frontmatter` };
  }

  const eqRel = fmText.indexOf("=", m.index + m[0].length);
  if (eqRel < 0) return { output: source, ok: false, reason: "no initializer" };
  const eqAbs = fm.start + eqRel;

  // Idempotent: bail if already wrapped.
  if (/^\s*await\s+editable\s*\(/.test(source.slice(eqAbs + 1, eqAbs + 48))) {
    return { output: source, ok: true, alreadyWrapped: true };
  }

  let initStart = eqAbs + 1;
  while (initStart < fm.end && /\s/.test(source[initStart])) initStart++;
  const initEnd = initializerEnd(source, eqAbs, fm.end);
  if (initEnd === null || initStart >= fm.end) {
    return { output: source, ok: false, reason: "could not bound initializer" };
  }

  const prefix = `await editable(${JSON.stringify(key)}, `;
  const suffix = `)`;

  // Pure insertion: keep every original character, add prefix/suffix around the
  // untouched initializer.
  let output =
    source.slice(0, initStart) +
    prefix +
    source.slice(initStart, initEnd) +
    suffix +
    source.slice(initEnd);

  // Add the import at the top of the frontmatter unless it's already there.
  if (!IMPORT_RE.test(source)) {
    output = output.slice(0, fm.start) + IMPORT_LINE + "\n" + output.slice(fm.start);
  }

  return { output, ok: true };
}

/**
 * Detect Tier-1 wrap targets: frontmatter consts initialized to an array/object
 * LITERAL that are `.map()`/`.flatMap()`'d in the template. Only literal-inited
 * consts qualify — loops over fetched data (getCollection/await) or imports
 * aren't inline content and are left alone. The key is derived from the file's
 * scope (`collection::id`) plus the variable name as the field.
 */
export function detectWrapTargets(source: string, relPath: string): WrapCandidate[] {
  const fm = frontmatterRange(source);
  if (!fm) return [];
  const fmText = source.slice(fm.start, fm.end);
  const template = source.slice(fm.end);

  // 1. frontmatter consts whose initializer is an array/object literal
  const literalConsts = literalConstNames(fmText);
  if (literalConsts.size === 0) return [];

  // 2. of those, the ones actually iterated in the template
  const mapped = new Set<string>();
  const mapRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:map|flatMap)\b/g;
  let mm: RegExpExecArray | null;
  while ((mm = mapRe.exec(template))) {
    if (literalConsts.has(mm[1])) mapped.add(mm[1]);
  }
  if (mapped.size === 0) return [];

  // 3. derive the scope + a key per target
  const scoped = deriveScope(relPath);
  if ("skip" in scoped) return [];
  const { collection, id } = scoped.scope;

  const candidates: WrapCandidate[] = [];
  for (const varName of mapped) {
    const field = isValidField(varName) ? varName : slugifyText(varName);
    if (!field) continue;
    candidates.push({ varName, key: `${collection}::${id}::${field}` });
  }
  return candidates;
}

/**
 * Safety-checked Tier-1 detection: the literal-const candidates from
 * `detectWrapTargets`, minus any whose mapped fields flow into a native-element
 * attribute (where `editable()`'s stega encoding would corrupt an href/src/class
 * /…). Component prop hand-offs are tolerated here — Tier-1's long-standing
 * behavior — and verified across files by the Tier-2 prop pass instead.
 *
 * Async because the safety check needs the parsed AST; `root` may be passed when
 * the caller has already parsed `source` (the CLI does, to avoid re-parsing).
 */
export async function detectWrapTargetsSafe(
  source: string,
  relPath: string,
  root?: AstroNode,
): Promise<WrapTarget[]> {
  const candidates = detectWrapTargets(source, relPath);
  if (candidates.length === 0) return [];
  const ast = root ?? (await parseAstro(source));
  return candidates
    .filter((t) => classifyConstUsage(ast, t.varName).safe)
    .map((t) => ({ ...t, origin: "loop" as const }));
}
