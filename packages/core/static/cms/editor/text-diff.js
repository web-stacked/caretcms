const ELLIPSIS = '…';

/**
 * The part of two texts that differs, by whole words, with "…" where shared
 * words were left out. "Call us. Mon–Fri 8–17." and "Call us. Mon–Sat 8–18."
 * become "…Mon–Fri 8–17." and "…Mon–Sat 8–18.". Short texts, or texts with
 * nothing in common, come back as they are.
 *
 * @param {string} before
 * @param {string} after
 * @returns {{ before: string, after: string }}
 */
export function changedPart(before, after) {
  const a = before.split(/(\s+)/), b = after.split(/(\s+)/);
  if (a.length < 7 && b.length < 7) return { before, after };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  // Keep one shared word on each side, so the change reads in context.
  start = Math.max(0, start - 2);
  end = Math.max(0, end - 2);
  const cut = (/** @type {string[]} */ words) => {
    const middle = words.slice(start, words.length - end).join('').trim();
    return `${start > 0 ? ELLIPSIS : ''}${middle}${end > 0 ? ELLIPSIS : ''}`;
  };
  return { before: cut(a), after: cut(b) };
}
