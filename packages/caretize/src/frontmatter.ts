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
 * imports (`import * as`), `import type`, and bare/package specifiers are excluded,
 * because their value shape can't be assumed safe to stega-encode. Relative/aliased
 * extensionless paths (`../data/site`) ARE included — see {@link classifyDataSpecifier}.
 * `import faqs from "./data/faqs.json"` → `faqs → {json}`.
 */
export function importBindingNames(
  fmText: string,
): Map<string, { specifier: string; importKind: ImportKind }> {
  const out = new Map<string, { specifier: string; importKind: ImportKind }>();
  const re = /\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmText))) {
    const [, name, spec] = m;
    const importKind = classifyDataSpecifier(spec);
    if (!importKind) continue; // bare/package or extensionless — shape unknown
    out.set(name, { specifier: spec, importKind });
  }
  return out;
}

/**
 * Shared specifier filter → the data kind, or null when the shape can't be assumed.
 * A `.json` file is `json`; a JS/TS module file is `module`; a relative or aliased
 * EXTENSIONLESS path (the user's own `../data/site`, `@/data/site`) is treated as a
 * `module` too — the most common way data files are actually imported. Bare package
 * specifiers (`react`, `@scope/pkg`) and non-data extensions (`.astro`, `.css`,
 * `.png`) stay null. The real wrap safety is enforced downstream by
 * `classifyConstUsage` on the AST, not by this specifier shape.
 */
function classifyDataSpecifier(spec: string): ImportKind | null {
  if (/\.json$/.test(spec)) return "json";
  if (/\.(?:js|ts|mjs|cjs|mts|cts)$/.test(spec)) return "module";
  if (isExtensionlessLocalPath(spec)) return "module";
  return null;
}

/**
 * A relative (`./`, `../`) or common-alias (`~/`, `@/`) path whose last segment has
 * no file extension — i.e. a local JS/TS module imported by its extensionless path
 * (`../data/site`). Excludes bare packages and any path ending in `.ext` (those are
 * handled by the explicit extension checks above, or intentionally left out).
 */
function isExtensionlessLocalPath(spec: string): boolean {
  const isLocal =
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("~/") ||
    spec.startsWith("@/");
  if (!isLocal) return false;
  const lastSegment = spec.slice(spec.lastIndexOf("/") + 1);
  return lastSegment.length > 0 && !lastSegment.includes(".");
}

/**
 * NAMED-import bindings whose data could be wrapped with `editable()`, mapped to
 * their specifier + kind. The named counterpart to {@link importBindingNames}:
 * `import { services } from "../data/site.ts"` → `services → {module}`.
 *
 * Same specifier filter (relative `.json`/JS-TS module only). Handles multiple
 * bindings per statement (`import { a, b }`), an inline `type` specifier
 * (`import { type T, a }` → only `a`), and a leading default binding
 * (`import def, { a }` → the named half). Namespace imports and `import type {…}`
 * are excluded.
 *
 * IMPORTANT — pre-aliased bindings are SKIPPED. A binding already written as
 * `X as Y` was renamed deliberately, and the named-import wrapper renames by
 * inserting ` as <raw>` after the local name; doing that to an aliased binding
 * would emit `{ X as Y as Yraw }` (invalid JS). So `import { data as items }`
 * yields nothing here.
 */
export function namedImportBindingNames(
  fmText: string,
): Map<string, { specifier: string; importKind: ImportKind }> {
  const out = new Map<string, { specifier: string; importKind: ImportKind }>();
  // Optional leading default binding (`def,`) then the `{ … }` named group.
  const re =
    /\bimport\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s+from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmText))) {
    const importKind = classifyDataSpecifier(m[2]);
    if (!importKind) continue;
    for (const raw of m[1].split(",")) {
      const token = raw.trim();
      if (!token) continue;
      if (/\bas\b/.test(token)) continue; // pre-aliased — skip (see doc above)
      if (/^type\b/.test(token)) continue; // inline `type` specifier
      if (!/^[A-Za-z_$][\w$]*$/.test(token)) continue;
      out.set(token, { specifier: m[2], importKind });
    }
  }
  return out;
}

/**
 * Local names that `astro:assets` `Image`/`Picture` are imported under, e.g.
 * `import { Image, Picture as Pic } from "astro:assets"` → `{"Image","Pic"}`.
 *
 * Used by `detect.ts` to recognize these components (which render to a native
 * `<img>` Astro forwards `data-caret` to) instead of skipping them as opaque
 * components. The specifier must be exactly `"astro:assets"`, so a user's own
 * `import { Image } from "./my-image"` is NOT matched. Unlike data-import
 * wrapping, aliasing is fine here — we only need the local name to match against,
 * nothing is renamed.
 */
export function imageComponentNames(fmText: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  // Named (incl. a leading default binding): import [Def,] { Image, … } from "astro:assets"
  const named =
    /\bimport\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s+from\s*['"]astro:assets['"]/g;
  while ((m = named.exec(fmText))) {
    for (const raw of m[1].split(",")) {
      const token = raw.trim();
      if (!token || /^type\b/.test(token)) continue;
      // `Image as Img` → local name is the alias; plain `Image` → itself.
      const aliased = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(token);
      const local = aliased ? aliased[1] : token;
      if (/^[A-Za-z_$][\w$]*$/.test(local)) out.add(local);
    }
  }
  // Default (rare/legacy): import Image from "astro:assets"
  const def = /\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\s*['"]astro:assets['"]/g;
  while ((m = def.exec(fmText))) out.add(m[1]);
  return out;
}
