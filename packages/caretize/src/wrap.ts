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

const IMPORT_LINE = `import { editable } from '@caretcms/core';`;
const IMPORT_RE =
  /import\s*\{[^}]*\beditable\b[^}]*\}\s*from\s*['"]@caretcms\/core['"]/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface WrapResult {
  output: string;
  ok: boolean;
  /** Reason when ok === false. */
  reason?: string;
  /** True when the source already had the wrap (no-op, idempotent). */
  alreadyWrapped?: boolean;
}

/** Inner content range of the frontmatter fence, or null if there is none. */
function frontmatterRange(source: string): { start: number; end: number } | null {
  if (!source.startsWith("---")) return null;
  const firstNL = source.indexOf("\n");
  if (firstNL < 0) return null;
  const close = source.indexOf("\n---", firstNL);
  if (close < 0) return null;
  return { start: firstNL + 1, end: close };
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
  if (!IDENT_RE.test(varName)) {
    return { output: source, ok: false, reason: `invalid identifier: ${varName}` };
  }

  const fm = frontmatterRange(source);
  if (!fm) return { output: source, ok: false, reason: "no frontmatter block" };

  const fmText = source.slice(fm.start, fm.end);
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${varName}\\b`);
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
