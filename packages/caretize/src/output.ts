/**
 * Output formatting for the caretize CLI — pure functions that turn a plan /
 * run result into the exact strings the CLI prints. Kept out of cli.ts (and free
 * of process.stdout) so the formatting is unit-testable in isolation.
 */

import type { FilePlan, PlannedTag } from "./plan.js";
import type { WrapTarget } from "./wrap.js";
import type { PropHoistTarget } from "./prop-hoist.js";
import type { CollectionBindTarget } from "./bind-collection.js";
import type { Preflight } from "./preflight.js";
import { lineDiff, formatHunks } from "./diff.js";
import { TIERS, type TierId } from "./tiers.js";
import { isTagNode, type TagNode } from "./parse.js";

type BindsByFile = Map<string, CollectionBindTarget[]>;

/** One-line description of a tag candidate, e.g. `<h1> "Hello"` or `<img> src="…"`. */
export function tagLine(t: PlannedTag): string {
  const text = t.candidate.text.replace(/\s+/g, " ").slice(0, 50);
  const what = t.candidate.kind === "image" ? `src="${text}"` : `"${text}"`;
  const rich = t.candidate.rich ? " [rich]" : "";
  return `<${t.candidate.tag}>${rich} ${what}`;
}

/** The post-scan tally line. When the project is already partly tagged
 *  (`priorTagged` > 0) this is a RE-RUN: frame candidates as "new" and note how
 *  many spots are already editable, so re-running reads as incremental progress
 *  rather than a cold scan. */
export function formatScanSummary(
  fileCount: number,
  plans: FilePlan[],
  wrapsByFile: Map<string, WrapTarget[]>,
  hoistsByFile: Map<string, PropHoistTarget[]>,
  bindsByFile: BindsByFile = new Map(),
  priorTagged = 0,
): string {
  const candidateTotal = plans.reduce((n, p) => n + p.tags.length, 0);
  const wrapTotal = [...wrapsByFile.values()].reduce((n, t) => n + t.length, 0);
  const hoistTotal = [...hoistsByFile.values()].reduce(
    (n, ts) => n + ts.reduce((m, t) => m + t.props.length, 0), 0,
  );
  const bindTotal = [...bindsByFile.values()].reduce((n, b) => n + b.length, 0);
  const bindPart = bindTotal ? ` · ${bindTotal} collection binding(s)` : "";
  const candidateLabel = priorTagged > 0 ? "new tag candidate(s)" : "tag candidate(s)";
  const priorPart = priorTagged > 0 ? ` · ${priorTagged} already editable` : "";
  return `✓ ${fileCount} .astro files · ${candidateTotal} ${candidateLabel} · ${wrapTotal} wrap target(s) · ${hoistTotal} prop(s)${bindPart}${priorPart}\n`;
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
  out += `───────────────────────────────\n`;
  return out;
}

/**
 * The single most-important "what now?" line, tailored to where the project
 * actually is in CaretCMS setup. Tagging succeeds even when nothing is editable
 * yet (core not installed / not wired / wrong output mode), so a generic
 * "click to edit" footer is misleading — point at the ONE next step instead.
 */
export function formatNextStep(pf: Preflight): string {
  if (!pf.hasCaretCore) {
    return (
      `Next: make these editable — install + wire CaretCMS:\n` +
      `    npx caretize init\n` +
      `    npx caretize\n` +
      `  Static Astro projects use caret() with automatic static delivery by default.\n`
    );
  }
  if (!pf.caretWired) {
    return (
      `Next: wire CaretCMS — add caret() to the integrations array in your astro.config,\n` +
      `  then npm run dev → click to edit.\n`
    );
  }
  if (pf.outputMode === "static") {
    if (pf.staticDeliveryConfigured) {
      return `Next: npm run dev → sign in at /admin → edit tagged content locally; Publish + rebuild bakes static HTML.\n`;
    }
    return (
      `Next: add caret() with delivery: "auto" (the default) for static HTML baking,\n` +
      `  or run: npx caretize init\n`
    );
  }
  return `Next: npm run dev → open your page → click to edit\n`;
}

/**
 * The grouped "I can also make these editable" offer shown after the default
 * review (interactive mode). Lists only tiers with a non-zero count, in TIERS
 * order, each tagged with its risk note (so the identity-guessing binders are
 * labeled before consent). Returns "" when there's nothing to offer.
 *
 * The prompt question itself (`[Y/n/customize]`) is asked by cli.ts via readline;
 * this renders only the menu body so it stays pure + testable.
 */
export function formatEscalationOffer(counts: Partial<Record<TierId, number>>): string {
  const lines: string[] = [];
  for (const t of TIERS) {
    const n = counts[t.id] ?? 0;
    if (n <= 0) continue;
    const flag = t.risk === "guess" ? " ⚠" : "";
    lines.push(`    •${flag} ${String(n).padStart(3)} ${t.label} — ${t.note}`);
  }
  if (lines.length === 0) return "";
  return `\n  I can also make these editable:\n${lines.join("\n")}\n`;
}

/**
 * The `--diff` preview: the actual before→after for every file that would change,
 * as hunks (changed lines + context). Makes the codemod tangible — "show me
 * exactly what you'd insert" — and pairs with the backup/--restore safety net.
 * Files that failed verification are surfaced via `formatFailures` separately.
 */
export function formatDiff(
  prepared: ReadonlyArray<{ relPath: string; source: string; output: string; tagCount: number; ok: boolean }>,
): string {
  let out = "";
  for (const p of prepared) {
    if (!p.ok || p.tagCount === 0 || p.output === p.source) continue;
    const body = formatHunks(lineDiff(p.source, p.output));
    if (body) out += `\n${p.relPath}\n${body}`;
  }
  return out || "\n(no changes to preview)\n";
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

/** Which opt-in tiers are already ON — a hint is only offered while its tier is off. */
export interface HintOpts {
  rich?: boolean;
  richClass?: boolean;
  collections?: boolean;
  routes?: boolean;
  lowconf?: boolean;
}

/**
 * Collect, from a skipped rich block, the inline descendants carrying a `class`
 * the sanitizer would strip — `tag → class tokens`. A `rich-unsafe-attrs` skip
 * only happens when every descendant is an inline tag, so walking them all is
 * safe. Dynamic class values (`class={x}`) are ignored — only literal tokens are
 * actionable in an `allowedClasses` config.
 */
function collectStyledClasses(node: TagNode | undefined, into: Map<string, Set<string>>): void {
  if (!node) return;
  for (const child of node.children ?? []) {
    if (!isTagNode(child)) continue;
    const cls = child.attributes.find((a) => a.name === "class")?.value;
    if (cls) {
      for (const token of cls.split(/\s+/)) {
        if (!/^[\w-]+$/.test(token)) continue; // skip dynamic/garbage tokens
        const tag = child.name.toLowerCase();
        (into.get(tag) ?? into.set(tag, new Set()).get(tag)!).add(token);
      }
    }
    collectStyledClasses(child, into);
  }
}

/** Render `tag → classes` as a copy-pasteable `allowedClasses` object literal. */
function renderAllowedClasses(byTag: Map<string, Set<string>>): string {
  const entries = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, classes]) => {
      const list = [...classes].sort().map((c) => `"${c}"`).join(", ");
      return `${tag}: [${list}]`;
    });
  return `{ ${entries.join(", ")} }`;
}

/**
 * The "what's left + how to get it" summary — so skipped coverage reads as one
 * unmissable checklist line, not four scattered re-run incantations. Every
 * remaining opt-in tier that's still OFF is rolled into a single line that
 * points at `--all` (the one flag), with the individual flags noted once.
 *
 * The styled-class case is kept separate: it isn't unlocked by a tier flag (the
 * sanitizer strips the class regardless) — it needs a CSS move or
 * caret({ allowedClasses }), so it carries its own guidance.
 *
 * Returns "" when there's nothing to say.
 */
export function formatHints(plans: FilePlan[], opts: HintOpts = {}): string {
  let eligible = 0; // rich-eligible (would tag with --rich)
  let styled = 0; // rich-unsafe-attrs (sanitizer strips the class)
  let richClassPromotable = 0; // rich-class-promotable (would tag with --rich-class)
  let inIterator = 0; // inside-iterator (would bind with --bind-collections)
  let belowConfidence = 0; // dropped by the --min-confidence floor
  const styledClasses = new Map<string, Set<string>>(); // tag → classes to bless
  const richClassToBless = new Map<string, Set<string>>(); // classes on rich-class blocks
  for (const p of plans) {
    belowConfidence += p.belowConfidence ?? 0;
    for (const s of p.skipped) {
      if (s.reason === "rich-eligible") eligible++;
      else if (s.reason === "rich-unsafe-attrs") {
        styled++;
        collectStyledClasses(s.node, styledClasses);
      } else if (s.reason === "rich-class-promotable") {
        richClassPromotable++;
        collectStyledClasses(s.node, richClassToBless);
      } else if (s.reason === "inside-iterator") inIterator++;
    }
    // Once --rich-class is on, the styled-span blocks are TAGGED (not skipped),
    // so harvest their classes from the promoted rich candidates for the
    // post-apply "now bless these" reminder.
    if (opts.richClass) {
      for (const t of p.tags ?? []) {
        if (t.candidate?.rich) collectStyledClasses(t.candidate.node, richClassToBless);
      }
    }
  }
  const dynamicRoutes = plans.filter((p) => p.scopeSkip === "dynamic-route").length;

  // The remaining opt-in coverage, each listed only while its tier is off.
  const parts: string[] = [];
  if (inIterator && !opts.collections) parts.push(`${inIterator} item(s) in dynamic lists`);
  if (dynamicRoutes && !opts.routes) parts.push(`${dynamicRoutes} dynamic detail route(s)`);
  if (eligible && !opts.rich) parts.push(`${eligible} rich heading(s)`);
  if (belowConfidence && !opts.lowconf) parts.push(`${belowConfidence} lower-confidence spot(s)`);

  let out = "";
  if (parts.length) {
    out += `\n↪ More can be made editable: ${parts.join(", ")}.\n` +
      `  Re-run with --all to include them (or the individual flags: ` +
      `--bind-collections --bind-routes --rich --min-confidence low).\n`;
  }
  if (styled) {
    const snippet = styledClasses.size
      ? renderAllowedClasses(styledClasses)
      : `{ tag: ["your-class"] }`;
    out += `↪ ${styled} block(s) hold inline styling classes the rich-text sanitizer strips on save.\n` +
      `  Move the styling to CSS (style the semantic tag), or bless the classes via\n` +
      `  caret({ allowedClasses: ${snippet} }) — then they're safe to tag.\n`;
  }
  // Styled-span headings: pre-tag it's a "--rich-class + bless" nudge; once
  // --rich-class is on (richClassToBless populated from the tagged blocks) it's
  // a "you tagged these — now bless them or the class is lost" reminder.
  if (richClassToBless.size) {
    const snippet = renderAllowedClasses(richClassToBless);
    if (opts.richClass) {
      out += `↪ Tagged styled-span heading(s) as rich. Keep their classes — add to caret():\n` +
        `    allowedClasses: ${snippet}\n` +
        `  Without it, those classes are stripped when an editor saves.\n`;
    } else {
      out += `↪ ${richClassPromotable} styled-span heading(s) can be tagged with --rich-class (in --all).\n` +
        `  They keep their class only once blessed — add to caret():\n` +
        `    allowedClasses: ${snippet}\n`;
    }
  }
  return out;
}
