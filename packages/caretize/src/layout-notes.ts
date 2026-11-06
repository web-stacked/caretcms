/**
 * Page chrome the Studio drawer can't move. CaretCMS 0.6's drawer moves the
 * page aside with padding on <html>; a `position: fixed` header or nav stays
 * where it is, under the drawer. Such sites can keep the drawer over the page
 * with `caret-studio-overlay`, so caretize points at it.
 *
 * A heuristic over template source, no I/O: a <header>/<nav> whose class list
 * has Tailwind's `fixed`, or a <style> rule for header/nav chrome that sets
 * `position: fixed`.
 */

const FIXED_CLASS = /<(?:header|nav)\b[^>]*\bclass(?::list)?\s*=\s*\{?\s*\[?\s*["'`][^"'`]*(?<![\w-])fixed(?![\w-])/i;
const FIXED_RULE = /(?:^|[}\s,])[^{}@]*\b(?:header|nav|navbar|topbar|site-header|masthead)\b[^{}]*\{[^}]*\bposition\s*:\s*fixed\b/i;

/** Whether one template renders fixed header or nav chrome. */
export function hasFixedChrome(source: string): boolean {
  if (FIXED_CLASS.test(source)) return true;
  for (const style of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (FIXED_RULE.test(style[1])) return true;
  }
  return false;
}

/** The templates (relative paths) that render fixed header or nav chrome. */
export function findFixedChrome(files: string[], read: (relPath: string) => string | null): string[] {
  return files.filter((relPath) => {
    const source = read(relPath);
    return source !== null && hasFixedChrome(source);
  });
}
