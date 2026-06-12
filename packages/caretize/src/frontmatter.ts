/**
 * Frontmatter parsing primitives shared by the wrap tiers (`wrap.ts`'s same-file
 * loop detection and `props.ts`'s cross-file prop detection). Kept neutral so
 * those two passes are siblings rather than one depending on the other.
 */

/** Inner content range of the frontmatter fence, or null if there is none.
 *  Tolerates a leading UTF-8 BOM — the compiler does too, and a bare
 *  startsWith("---") used to silently disable every frontmatter tier for
 *  BOM-prefixed files. */
export function frontmatterRange(source: string): { start: number; end: number } | null {
  const fenceAt = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!source.startsWith("---", fenceAt)) return null;
  const firstNL = source.indexOf("\n");
  if (firstNL < 0) return null;
  const close = source.indexOf("\n---", firstNL);
  if (close < 0) return null;
  return { start: firstNL + 1, end: close };
}

/** Names of frontmatter consts whose initializer is an array/object literal. */
export function literalConstNames(fmText: string): Set<string> {
  const set = new Set<string>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([[{])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmText))) set.add(m[1]);
  return set;
}

export type ImportKind = "json" | "module";

/**
 * Default-import bindings whose data could be wrapped with `editable()`, mapped
 * to their specifier + kind. Only DEFAULT imports of a `.json` data file or a
 * `.js`/`.ts` module are returned — named imports (`import { x }`), namespace
 * imports (`import * as`), `import type`, and bare/package or extensionless
 * specifiers are excluded, because their value shape can't be assumed safe to
 * stega-encode. `import faqs from "./data/faqs.json"` → `faqs → {json}`.
 */
export function importBindingNames(
  fmText: string,
): Map<string, { specifier: string; importKind: ImportKind }> {
  const out = new Map<string, { specifier: string; importKind: ImportKind }>();
  const re = /\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmText))) {
    const [, name, spec] = m;
    let importKind: ImportKind;
    if (/\.json$/.test(spec)) importKind = "json";
    else if (/\.(?:js|ts|mjs|cjs|mts|cts)$/.test(spec)) importKind = "module";
    else continue; // bare/package or extensionless — shape unknown, leave alone
    out.set(name, { specifier: spec, importKind });
  }
  return out;
}
