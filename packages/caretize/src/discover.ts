/**
 * Discovery: find the `.astro` files to consider, relative to the project root.
 *
 * Never descends into build/vendor/output dirs, and never touches symlinks that
 * escape the project root (a safety invariant — caretize only edits files
 * inside the project it was pointed at).
 */

import { readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".astro",
  ".caret",
  ".git",
  "dist",
  ".vercel",
  ".netlify",
  ".output",
]);

function isSkippedFile(name: string): boolean {
  if (!name.endsWith(".astro")) return true;
  return /\.(test|spec)\.astro$/.test(name);
}

/** True if `child` resolves to a path inside `root` (no symlink escape). */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  // `relative` is absolute only when the paths share no root (other drive).
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Walk `target` (a file or directory) under `rootDir`, returning project-root-
 * relative POSIX-ish paths of `.astro` files, sorted for deterministic order.
 */
export function discoverAstroFiles(rootDir: string, target?: string): string[] {
  const root = resolve(rootDir);
  const start = resolve(root, target ?? "src");
  // SKIP_DIRS guards descent below, but an EXPLICIT target like
  // `node_modules/pkg/src` starts inside one — check every ancestor segment.
  const startRel = relative(root, start);
  if (startRel.split(sep).some((segment) => SKIP_DIRS.has(segment))) return [];
  const found: string[] = [];

  const visit = (abs: string): void => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    // Reject symlinks that point outside the project root.
    if (st.isSymbolicLink()) {
      let realPath: string;
      try {
        realPath = realpathSync(abs);
      } catch {
        return;
      }
      if (!isInside(root, realPath)) return;
      st = statSync(abs);
    }

    if (st.isDirectory()) {
      const base = abs.split(sep).pop() ?? "";
      if (SKIP_DIRS.has(base)) return;
      let entries: string[];
      try {
        entries = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of entries.sort()) visit(join(abs, name));
      return;
    }

    if (st.isFile()) {
      const base = abs.split(sep).pop() ?? "";
      if (isSkippedFile(base)) return;
      found.push(relative(root, abs).split(sep).join("/"));
    }
  };

  visit(start);
  return found;
}
