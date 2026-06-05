/**
 * Frontmatter parsing primitives shared by the wrap tiers (`wrap.ts`'s same-file
 * loop detection and `props.ts`'s cross-file prop detection). Kept neutral so
 * those two passes are siblings rather than one depending on the other.
 */

/** Inner content range of the frontmatter fence, or null if there is none. */
export function frontmatterRange(source: string): { start: number; end: number } | null {
  if (!source.startsWith("---")) return null;
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
