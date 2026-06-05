/**
 * Minimal component-import resolution for the cross-file prop pass.
 *
 * Given an importer's source and a component name, find its `import … from`
 * specifier and resolve it to a project-root-relative `.astro` path. Only RELATIVE
 * specifiers are resolved: bare/`npm` packages and tsconfig path aliases
 * (`~/…`, `@/…`) need build config we don't read, so they return null and the
 * caller conservatively skips that hand-off rather than guess.
 */

import { posix } from "node:path";
import { escapeRe } from "./identifiers.js";

/**
 * Resolve `componentName`'s source path relative to the project root, or null
 * when the import is absent or not a resolvable relative `.astro` specifier.
 */
export function resolveComponentImport(
  importerSource: string,
  componentName: string,
  importerRelPath: string,
): string | null {
  // Default import of the component, tolerating a trailing named group:
  // `import Name from '…'` and `import Name, { X } from '…'`. The `(?![\w$])`
  // bounds the name so `Card` doesn't match `CardList`.
  const re = new RegExp(
    `import\\s+${escapeRe(componentName)}(?![\\w$])[^'"\\n]*?from\\s*['"]([^'"]+)['"]`,
  );
  const m = re.exec(importerSource);
  if (!m) return null;

  let spec = m[1];
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null; // alias/bare → unresolvable here

  if (!spec.endsWith(".astro")) {
    if (/\.\w+$/.test(spec)) return null; // a non-.astro file (e.g. .tsx) — out of scope for v1
    spec += ".astro";
  }

  const dir = posix.dirname(importerRelPath.replace(/\\/g, "/"));
  return posix.normalize(posix.join(dir, spec));
}
