/**
 * Output formatting for the caretize CLI — pure functions that turn a plan /
 * run result into the exact strings the CLI prints. Kept out of cli.ts (and free
 * of process.stdout) so the formatting is unit-testable in isolation.
 */

import type { FilePlan, PlannedTag } from "./plan.js";
import type { WrapTarget } from "./wrap.js";
import type { PropHoistTarget } from "./prop-hoist.js";
import type { CollectionBindTarget } from "./bind-collection.js";

type BindsByFile = Map<string, CollectionBindTarget[]>;

/** One-line description of a tag candidate, e.g. `<h1> "Hello"` or `<img> src="…"`. */
export function tagLine(t: PlannedTag): string {
  const text = t.candidate.text.replace(/\s+/g, " ").slice(0, 50);
  const what = t.candidate.kind === "image" ? `src="${text}"` : `"${text}"`;
  const rich = t.candidate.rich ? " [rich]" : "";
  return `<${t.candidate.tag}>${rich} ${what}`;
}

/** The post-scan tally line. */
export function formatScanSummary(
  fileCount: number,
  plans: FilePlan[],
  wrapsByFile: Map<string, WrapTarget[]>,
  hoistsByFile: Map<string, PropHoistTarget[]>,
  bindsByFile: BindsByFile = new Map(),
): string {
  const candidateTotal = plans.reduce((n, p) => n + p.tags.length, 0);
  const wrapTotal = [...wrapsByFile.values()].reduce((n, t) => n + t.length, 0);
  const hoistTotal = [...hoistsByFile.values()].reduce(
    (n, ts) => n + ts.reduce((m, t) => m + t.props.length, 0), 0,
  );
  const bindTotal = [...bindsByFile.values()].reduce((n, b) => n + b.length, 0);
  const bindPart = bindTotal ? ` · ${bindTotal} collection binding(s)` : "";
  return `✓ ${fileCount} .astro files · ${candidateTotal} tag candidate(s) · ${wrapTotal} wrap target(s) · ${hoistTotal} prop(s)${bindPart}\n`;
}

/** The full `--dry-run` plan dump, ending with the "nothing written" footer. */
export function formatPlan(
  plans: FilePlan[],
  wrapsByFile: Map<string, WrapTarget[]>,
  hoistsByFile: Map<string, PropHoistTarget[]>,
  bindsByFile: BindsByFile = new Map(),
): string {
  let out = "";
  for (const plan of plans) {
    const wraps = wrapsByFile.get(plan.relPath) ?? [];
    const hoists = hoistsByFile.get(plan.relPath) ?? [];
    const binds = bindsByFile.get(plan.relPath) ?? [];
    if (plan.tags.length === 0 && plan.flags.length === 0 && wraps.length === 0 && hoists.length === 0 && binds.length === 0) continue;
    out += `\n${plan.relPath}${plan.scopeSkip ? `  (skipped: ${plan.scopeSkip})` : ""}\n`;
    for (const t of plan.tags) out += `  + data-caret="${t.binding}"  ${tagLine(t)}\n`;
    for (const w of wraps) {
      const via = w.origin === "prop" ? " (via component prop)" : w.origin === "import" ? " (via data import)" : "";
      const kind = w.origin === "import" ? "import" : "const";
      out += `  ~ editable("${w.key}")  wrap ${kind} ${w.varName}${via}\n`;
    }
    for (const h of hoists) {
      for (const p of h.props) {
        out += `  ⤴ editable("${p.key}")  hoist <${h.componentName}> ${p.propName}${p.isRich ? " [rich]" : ""}\n`;
      }
    }
    for (const b of binds) {
      const id = b.kind === "route" ? "${entry}" : "*";
      const note = b.kind === "route" ? "current entry" : "per-row collection loop";
      out += `  ⟳ data-caret  bind <${b.tag}> ${b.collection}::${id}::${b.field}  (${note})\n`;
    }
    for (const f of plan.flags) out += `  ⚠ ${f.method}() loop — consider a dynamic collection\n`;
  }
  out += "\n(dry run — nothing written)\n";
  return out;
}

/** The closing summary block after a commit. */
export function formatSummary(
  files: number,
  changes: number,
  wrapped: number,
  hoisted: number,
  flagged: number,
  hadBackups: boolean,
  bound = 0,
): string {
  let out = `\n───────────────────────────────\n`;
  out += `✓ ${changes} change(s) across ${files} file(s)\n`;
  if (wrapped) out += `✓ ${wrapped} data array(s) wrapped with editable()\n`;
  if (hoisted) out += `✓ ${hoisted} component prop(s) hoisted to editable()\n`;
  if (bound) out += `✓ ${bound} collection field(s) bound to data-caret\n`;
  if (flagged) out += `⚠ ${flagged} loop(s) flagged → consider dynamic collections\n`;
  if (hadBackups) out += `⤺ backups in .caret/.caretize-bak/ (caretize --restore to undo)\n`;
  out += `───────────────────────────────\nNext: npm run dev → open your page → click to edit\n`;
  return out;
}

/** Files whose prepared output failed verification — shown in --dry-run too,
 *  so the user learns BEFORE the real run aborts on them. */
export function formatFailures(
  prepared: ReadonlyArray<{ relPath: string; ok: boolean; reason?: string }>,
): string {
  const failing = prepared.filter((p) => !p.ok);
  if (failing.length === 0) return "";
  return (
    failing
      .map((p) => `✗ ${p.relPath} would fail verification: ${p.reason ?? "unknown reason"}`)
      .join("\n") + "\n"
  );
}

/**
 * The actionable-skips hints — the "why isn't this editable?" answers — so a skip
 * reads as a checklist item, not a silent omission. Adapts to the flags already
 * passed: a hint only appears while its unlock flag is off. Returns "" when
 * there's nothing to say.
 */
export function formatHints(
  plans: FilePlan[],
  rich: boolean,
  opts: { bindCollections?: boolean; bindRoutes?: boolean } = {},
): string {
  let eligible = 0;
  let styled = 0;
  let inIterator = 0;
  for (const p of plans) {
    for (const s of p.skipped) {
      if (s.reason === "rich-eligible") eligible++;
      else if (s.reason === "rich-unsafe-attrs") styled++;
      else if (s.reason === "inside-iterator") inIterator++;
    }
  }
  const dynamicRoutes = plans.filter((p) => p.scopeSkip === "dynamic-route").length;
  let out = "";
  if (eligible && !rich) {
    out += `\n↪ ${eligible} mixed-content block(s) are sanitizer-safe inline markup — re-run with --rich to make them editable.\n`;
  }
  if (styled) {
    out += `↪ ${styled} block(s) hold inline styling classes the rich-text sanitizer strips on save.\n` +
      `  Move the styling to CSS (style the semantic tag), or bless the class via\n` +
      `  caret({ allowedClasses: { tag: ["your-class"] } }) — then they're safe to tag.\n`;
  }
  if (inIterator && !opts.bindCollections) {
    out += `↪ ${inIterator} element(s) render inside collection loops — re-run with --bind-collections to bind them per row.\n`;
  }
  if (dynamicRoutes && !opts.bindRoutes) {
    out += `↪ ${dynamicRoutes} dynamic route(s) skipped — re-run with --bind-routes to bind each detail page to its entry.\n`;
  }
  return out;
}
