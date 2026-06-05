/**
 * Tier-2 cross-file prop wrapping — detection only.
 *
 * Finds frontmatter array/object literals that a page passes straight into a
 * component as a prop (`<Features items={features} />`), follows the import into
 * that child, and confirms — strictly — that every field of the value renders
 * there as visible TEXT and never as a native-element attribute. Only then is the
 * parent const a safe `editable()` wrap target. The wrap itself stays in the
 * parent file (the same pure-insertion `wrapConst` Tier-1 uses); no child file is
 * ever modified.
 *
 * Conservative by construction — a hand-off is wrapped only on positive proof:
 *   - import not a resolvable relative `.astro`  → skip
 *   - child file unreadable                       → skip
 *   - prop not a simple `Astro.props` destructure → skip
 *   - child re-passes the prop to a component      → skip (grandchild unverified)
 *   - any field used in a native attribute (here or in the child) → skip
 */

import { parseAstro, type AstroNode } from "./parse.js";
import { deriveScope, isValidField, slugifyText } from "./name.js";
import { classifyConstUsage } from "./usage.js";
import { resolveComponentImport } from "./resolve.js";
import { frontmatterRange, literalConstNames } from "./frontmatter.js";
import { IDENT } from "./identifiers.js";
import type { WrapTarget } from "./wrap.js";

/** Reads a project-root-relative path, or returns null if it doesn't exist. */
export type FileReader = (relPath: string) => string | null;

/**
 * The local identifier a child binds `prop` to via `const { … } = Astro.props`.
 * Returns the destructured name (or its `prop: alias` rename), or null when the
 * child doesn't destructure props simply — in which case we can't trace usage
 * and the caller skips.
 */
export function propLocalName(childSource: string, prop: string): string | null {
  const re = /const\s*\{([^}]*)\}\s*=\s*Astro\.props/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(childSource))) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg || seg.startsWith("...")) continue;
      // `prop`, `prop: alias`, or `prop = default` (strip the default).
      const key = seg.split(/[:=]/)[0].trim();
      if (key !== prop) continue;
      const colon = seg.indexOf(":");
      if (colon >= 0) {
        const alias = seg.slice(colon + 1).split("=")[0].trim();
        return IDENT.test(alias) ? alias : null;
      }
      return IDENT.test(key) ? key : null;
    }
  }
  return null;
}

/** Verify a child renders `prop`'s fields as text only (strict: no re-handoff). */
async function childRendersPropAsText(
  childSource: string,
  prop: string,
): Promise<boolean> {
  const local = propLocalName(childSource, prop);
  if (!local) return false;
  const root = await parseAstro(childSource);
  return classifyConstUsage(root, local, { componentHandoffUnsafe: true }).safe;
}

/**
 * Detect Tier-2 wrap targets: literal consts handed to a component as a prop
 * whose child provably renders them as text. `readFile` resolves sibling files
 * (injected so this stays testable without a real filesystem).
 */
export async function detectPropWrapTargets(
  source: string,
  relPath: string,
  readFile: FileReader,
  root?: AstroNode,
): Promise<WrapTarget[]> {
  const scoped = deriveScope(relPath);
  if ("skip" in scoped) return [];
  const { collection, id } = scoped.scope;

  const fm = frontmatterRange(source);
  if (!fm) return [];
  const literals = literalConstNames(source.slice(fm.start, fm.end));
  if (literals.size === 0) return [];

  const ast = root ?? (await parseAstro(source));
  const targets: WrapTarget[] = [];

  for (const varName of literals) {
    // Local usage: gather this const's component hand-offs, and bail if a field
    // already lands in a native-element attribute in THIS file.
    const local = classifyConstUsage(ast, varName); // lenient: collect handoffs
    if (!local.safe) continue;

    // Only consts actually passed to a component as a prop are Tier-2's business;
    // pure local-loop consts are Tier-1's. Dedup hand-offs by component+prop.
    const seen = new Set<string>();
    const handoffs = local.handoffs.filter((h) => {
      const k = `${h.component}::${h.prop}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (handoffs.length === 0) continue;

    // Every hand-off must resolve to a child that renders the prop as text.
    let allSafe = true;
    for (const h of handoffs) {
      const childRel = resolveComponentImport(source, h.component, relPath);
      const childSrc = childRel ? readFile(childRel) : null;
      if (!childSrc || !(await childRendersPropAsText(childSrc, h.prop))) {
        allSafe = false;
        break;
      }
    }
    if (!allSafe) continue;

    const field = isValidField(varName) ? varName : slugifyText(varName);
    if (!field) continue;
    targets.push({ varName, key: `${collection}::${id}::${field}`, origin: "prop" });
  }

  return targets;
}
