#!/usr/bin/env node
/**
 * caretize CLI — scan an Astro project and add `data-caret` attributes.
 *
 * Thin shell over the engine (discover → plan → prepare → commit). The
 * load-bearing logic lives in the tested modules; this file is the interactive
 * review loop plus orchestration. Argument parsing lives in ./cli-args, output
 * formatting in ./output — both pure and unit-tested.
 */

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { parseAstro } from "./parse.js";
import { discoverAstroFiles } from "./discover.js";
import { preflight } from "./preflight.js";
import { planFile, type FilePlan, type PlannedTag, type PlanOptions } from "./plan.js";
import { prepareFileFull, commitRun, readSource, type PreparedFile } from "./run.js";
import { detectWrapTargetsSafe, type WrapTarget } from "./wrap.js";
import {
  detectImportWrapTargetsSafe,
  detectNamedImportWrapTargetsSafe,
} from "./import-wrap.js";
import { detectPropWrapTargets, type FileReader } from "./props.js";
import { detectPropHoistTargets, type PropHoistTarget } from "./prop-hoist.js";
import { detectCollectionBindTargets, type CollectionBindTarget } from "./bind-collection.js";
import { detectRouteBindTargets } from "./bind-route.js";
import { restoreLatest } from "./backup.js";
import { buildReport } from "./report.js";
import { applyKeyRegistry } from "./keys.js";
import { isValidField } from "./name.js";
import { parseArgs, CliUsageError, HELP, type Args } from "./cli-args.js";
import { tagLine, formatScanSummary, formatPlan, formatSummary, formatHints, formatFailures, formatEscalationOffer, formatNextStep, formatDiff, type HintOpts } from "./output.js";
import { selectTiers, type Intent } from "./select-policy.js";
import { tierById, type TierId } from "./tiers.js";
import {
  escalationCounts, offerableCounts, offeredTiers, recommendedBundle,
  totalOffer, deltaTags, mergeTagMaps, parseAnswer, parseToggle,
} from "./escalation.js";
import type { Confidence } from "./detect.js";

const VERSION = "0.1.0";

function fail(msg: string): never {
  process.stderr.write(`caretize: ${msg}\n`);
  process.exit(2);
}

type Readline = ReturnType<typeof createInterface>;

function ask(rl: Readline, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (ans) => res(ans.trim())));
}

interface Selection {
  tags: Map<string, PlannedTag[]>;
  wraps: Map<string, WrapTarget[]>;
  hoists: Map<string, PropHoistTarget[]>;
  binds: Map<string, CollectionBindTarget[]>;
  /** The user quit the interactive review — abort instead of committing an
   *  empty run (which used to print the success footer). */
  quit: boolean;
}

/** Prompt for a replacement field name on one tag. Returns the tag to keep: the
 *  edited tag for a valid name, the original when the prompt is left blank, or
 *  null when a non-empty name is invalid (the candidate is dropped). */
async function editField(rl: Readline, t: PlannedTag): Promise<PlannedTag | null> {
  const field = await ask(rl, `  new field name (${t.field}): `);
  if (field && isValidField(field)) {
    return { ...t, field, binding: `${t.collection}::${t.id}::${field}`, attribute: `data-caret="${t.collection}::${t.id}::${field}"` };
  }
  process.stdout.write(field ? "  invalid field name; skipped\n" : "  kept original\n");
  return field ? null : t;
}

interface TagReview { take: PlannedTag[]; skipFile: boolean; quit: boolean; acceptAll: boolean }

/**
 * File-level tag review (the default unit). High-confidence content tags are
 * safe by the engine's own definition, so interrogating each one is ceremony —
 * show the file's tags as a batch and accept them in one keystroke. Drop to the
 * per-candidate loop only when the user asks ([r]eview each), where edits live.
 */
async function reviewFileTags(rl: Readline, plan: FilePlan, acceptAll: boolean): Promise<TagReview> {
  if (acceptAll) return { take: [...plan.tags], skipFile: false, quit: false, acceptAll: true };

  process.stdout.write(`\n${plan.relPath}\n`);
  for (const t of plan.tags) {
    process.stdout.write(`  ${tagLine(t)}  → data-caret="${t.binding}" (${t.confidence})\n`);
  }
  for (;;) {
    const ans = (await ask(
      rl,
      `  accept all ${plan.tags.length} tag(s)? [Y]es · [r]eview each · [s]kip file · [A]ll files · [q]uit > `,
    )) || "y";
    if (ans === "q") return { take: [], skipFile: false, quit: true, acceptAll };
    if (ans === "s" || ans === "S") return { take: [], skipFile: true, quit: false, acceptAll };
    if (ans === "A") return { take: [...plan.tags], skipFile: false, quit: false, acceptAll: true };
    if (ans === "r") return reviewEachTag(rl, plan, acceptAll);
    // Only y/Y/<enter> accept this file — NOT lowercase "a", which would collide
    // with "[A]ll files" in the same prompt (a fat-fingered A must never silently
    // mean "this file only").
    if (ans === "y" || ans === "Y") {
      return { take: [...plan.tags], skipFile: false, quit: false, acceptAll };
    }
    process.stdout.write("  unrecognized — Y(es) r(eview each) s(kip file) A(ll files) q(uit)\n");
  }
}

/** Per-candidate prompt for one file (entered via [r]eview each). Returns the
 *  accepted tags plus control signals: `quit` aborts the whole run, `skipFile`
 *  skips this file's wrap/hoist prompts, and `acceptAll` carries the sticky
 *  [A]ll choice on to later files. */
async function reviewEachTag(
  rl: Readline,
  plan: FilePlan,
  acceptAll: boolean,
): Promise<TagReview> {
  const take: PlannedTag[] = [];
  let skipFile = false;
  for (let i = 0; i < plan.tags.length && !skipFile; i++) {
    const t = plan.tags[i];
    if (acceptAll) { take.push(t); continue; }
    process.stdout.write(
      `\n${plan.relPath}\n  ${tagLine(t)}\n  + data-caret="${t.binding}"  (${t.confidence})\n`,
    );
    // Only explicit answers act; anything unrecognized re-prompts. The old
    // fall-through-to-accept made a typo — including the natural "n" — mint a
    // permanent storage key.
    let answered = false;
    while (!answered) {
      const ans = (await ask(rl, "  [a]ccept [s]kip [e]dit [A]ll [S]kip-file [q]uit > ")) || "a";
      answered = true;
      if (ans === "q") return { take, skipFile, quit: true, acceptAll };
      else if (ans === "S") skipFile = true;
      else if (ans === "A") { acceptAll = true; take.push(t); }
      else if (ans === "s" || ans === "n" || ans === "N") { /* skip */ }
      else if (ans === "e") { const edited = await editField(rl, t); if (edited) take.push(edited); }
      else if (ans === "a" || ans === "y" || ans === "Y") take.push(t);
      else {
        process.stdout.write("  unrecognized — a(ccept) s(kip) e(dit) A(ll) S(kip-file) q(uit)\n");
        answered = false;
      }
    }
  }
  return { take, skipFile, quit: false, acceptAll };
}

/** Confirm wrapping a file's data array(s) with editable(). */
async function confirmWraps(rl: Readline, relPath: string, fileWraps: WrapTarget[]): Promise<boolean> {
  const names = fileWraps.map((w) => w.varName).join(", ");
  const ans = (await ask(
    rl,
    `\n${relPath}\n  wrap ${fileWraps.length} data array(s) [${names}] with editable()? [Y/n] `,
  )) || "y";
  return ans.toLowerCase() !== "n";
}

/** Per-component confirm for hoisting static prop string(s) to editable(). */
async function confirmHoists(
  rl: Readline,
  relPath: string,
  fileHoists: PropHoistTarget[],
): Promise<PropHoistTarget[]> {
  const take: PropHoistTarget[] = [];
  for (const h of fileHoists) {
    const lines = h.props
      .map((p) => {
        const v = p.literalValue.replace(/\s+/g, " ").slice(0, 40);
        const rich = p.isRich ? " [rich]" : "";
        return `    ${p.propName}="${v}"${rich}  →  ${p.propName}={${p.constName}}  (editable "${p.key}")`;
      })
      .join("\n");
    const ans = (await ask(
      rl,
      `\n${relPath}\n  <${h.componentName}> — hoist ${h.props.length} prop(s) to editable()?\n${lines}\n  [Y/n] `,
    )) || "y";
    if (ans.toLowerCase() !== "n") take.push(h);
  }
  return take;
}

/** Interactive review: per-candidate tags, then per-file wrap + prop-hoist confirms.
 *  Collection bindings (opt-in via --bind-collections) are auto-accepted per file
 *  — the flag is the consent — unless the file is skipped or the run is quit. */
async function review(
  plans: FilePlan[],
  wrapsByFile: Map<string, WrapTarget[]>,
  hoistsByFile: Map<string, PropHoistTarget[]>,
  bindsByFile: Map<string, CollectionBindTarget[]>,
): Promise<Selection> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Without a listener, readline swallows Ctrl-C and the process hangs at the
  // prompt. Nothing is written until commitRun (after the review), so exiting
  // here is always safe.
  rl.on("SIGINT", () => {
    process.stdout.write("\naborted — nothing written\n");
    process.exit(130);
  });
  const tags = new Map<string, PlannedTag[]>();
  const wraps = new Map<string, WrapTarget[]>();
  const hoists = new Map<string, PropHoistTarget[]>();
  const binds = new Map<string, CollectionBindTarget[]>();
  let acceptAll = false;
  try {
    for (const plan of plans) {
      const fileWraps = wrapsByFile.get(plan.relPath) ?? [];
      const fileHoists = hoistsByFile.get(plan.relPath) ?? [];
      const fileBinds = bindsByFile.get(plan.relPath) ?? [];
      if (plan.tags.length === 0 && fileWraps.length === 0 && fileHoists.length === 0 && fileBinds.length === 0) continue;

      const res = await reviewFileTags(rl, plan, acceptAll);
      acceptAll = res.acceptAll;
      if (res.quit) {
        tags.clear(); wraps.clear(); hoists.clear(); binds.clear();
        return { tags, wraps, hoists, binds, quit: true };
      }
      if (res.take.length) tags.set(plan.relPath, res.take);
      if (res.skipFile) continue;

      if (fileWraps.length > 0 && (await confirmWraps(rl, plan.relPath, fileWraps))) {
        wraps.set(plan.relPath, fileWraps);
      }
      if (fileHoists.length > 0) {
        const take = await confirmHoists(rl, plan.relPath, fileHoists);
        if (take.length) hoists.set(plan.relPath, take);
      }
      if (fileBinds.length > 0) binds.set(plan.relPath, fileBinds);
    }
  } finally {
    rl.close();
  }
  return { tags, wraps, hoists, binds, quit: false };
}

interface Analysis {
  plans: FilePlan[];
  wrapsByFile: Map<string, WrapTarget[]>;
  hoistsByFile: Map<string, PropHoistTarget[]>;
  bindsByFile: Map<string, CollectionBindTarget[]>;
}

/**
 * Parse each file ONCE, then drive all detection passes off that single AST:
 *   - planFile: the data-caret tag plan
 *   - detectWrapTargetsSafe: same-file data-array loops (Tier-1), dropped when a
 *     field would land in a native attribute
 *   - detectPropWrapTargets: literals passed to a component whose child provably
 *     renders them as text (Tier-2, cross-file)
 *   - detectImportWrapTargetsSafe: arrays from a DEFAULT data import (Tier-3)
 *   - detectNamedImportWrapTargetsSafe: arrays from a NAMED import (Tier-3, named)
 *   - detectPropHoistTargets: static component-prop strings (unless --no-props)
 */
async function analyzeFiles(
  root: string,
  files: string[],
  planOpts: PlanOptions,
  readFileSafe: FileReader,
  noProps: boolean,
  bindCollections: boolean,
  bindRoutes: boolean,
): Promise<Analysis> {
  const plans: FilePlan[] = [];
  const wrapsByFile = new Map<string, WrapTarget[]>();
  const hoistsByFile = new Map<string, PropHoistTarget[]>();
  const bindsByFile = new Map<string, CollectionBindTarget[]>();
  for (const rel of files) {
    const src = readSource(root, rel);
    const ast = await parseAstro(src);
    const plan = await planFile(src, rel, planOpts, ast);
    plans.push(plan);

    const loops = await detectWrapTargetsSafe(src, rel, ast);
    const props = await detectPropWrapTargets(src, rel, readFileSafe, ast);
    const imports = [
      ...(await detectImportWrapTargetsSafe(src, rel, ast)),
      ...(await detectNamedImportWrapTargetsSafe(src, rel, ast)),
    ];
    const byName = new Map<string, WrapTarget>();
    for (const t of [...loops, ...props, ...imports]) byName.set(t.varName, t);
    if (byName.size) wrapsByFile.set(rel, [...byName.values()]);

    // Tier-5 (--bind-collections): bind direct-render getCollection().map() loops.
    // Tier-6 (--bind-routes): bind a dynamic detail page to its current entry.
    const binds = [
      ...(bindCollections ? detectCollectionBindTargets(src, ast) : []),
      ...(bindRoutes ? detectRouteBindTargets(src, ast) : []),
    ];
    if (binds.length) bindsByFile.set(rel, binds);
    const boundReceivers = new Set(binds.map((b) => b.receiver));

    // A loop whose receiver a wrap tier (Tier-1/Tier-3) OR a bind tier (Tier-5)
    // just made editable no longer warrants the "consider a dynamic collection"
    // flag — suppress it so we don't tell the user to rethink a covered loop.
    plan.flags = plan.flags.filter(
      (f) => !f.receiver || (!byName.has(f.receiver) && !boundReceivers.has(f.receiver)),
    );

    if (!noProps) {
      const hoists = await detectPropHoistTargets(src, rel, readFileSafe, ast);
      if (hoists.length) hoistsByFile.set(rel, hoists);
    }

    // Cross-tier key registry: existing data-caret/editable() keys are
    // pre-claimed; tags claim first (content-derived, shown in review), then
    // wraps, then hoists. A collision takes a `_2` field suffix — without
    // this, one run could mint the same storage key twice with two value
    // shapes (a tag's string vs a wrap's array), or re-mint a key a prior
    // run's editable() already owns.
    applyKeyRegistry(
      src,
      plan.scope,
      plan.tags,
      wrapsByFile.get(rel) ?? [],
      hoistsByFile.get(rel) ?? [],
    );
  }
  return { plans, wrapsByFile, hoistsByFile, bindsByFile };
}

/** Select every default-tier candidate (no per-item review). The safe tier is
 *  lossless + reversible, so this is the optimistic default; the escalation
 *  prompt still gates the risky tiers, and --restore undoes everything. */
function selectAll(a: Analysis): Selection {
  const allTags = new Map(a.plans.map((p) => [p.relPath, p.tags] as [string, PlannedTag[]]));
  return { tags: allTags, wraps: a.wrapsByFile, hoists: a.hoistsByFile, binds: a.bindsByFile, quit: false };
}

/** Decide what to apply: everything (dry-run / -y / --diff / optimistic default),
 *  the opt-in per-file review (--review), or nothing (report-only). Errors out on
 *  a non-interactive run with no directive. */
async function selectChanges(args: Args, a: Analysis): Promise<Selection> {
  if (args.dryRun || args.yes || args.diff) return selectAll(a);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    // Optimistic by default: apply the safe tier, then show a diff you can undo.
    // --review opts back into approving each change before it's written.
    return args.review ? review(a.plans, a.wrapsByFile, a.hoistsByFile, a.bindsByFile) : selectAll(a);
  }
  if (args.report) return { tags: new Map(), wraps: new Map(), hoists: new Map(), binds: new Map(), quit: false };
  fail("non-interactive terminal: pass --dry-run, -y, or --report");
}

/** Prepare (verify) every touched file in memory — tags + binds + wraps + hoists. */
async function prepareTouched(root: string, sel: Selection): Promise<PreparedFile[]> {
  const touched = new Set<string>([
    ...sel.tags.keys(), ...sel.wraps.keys(), ...sel.hoists.keys(), ...sel.binds.keys(),
  ]);
  const prepared: PreparedFile[] = [];
  for (const rel of touched) {
    const tags = sel.tags.get(rel) ?? [];
    const targets = sel.wraps.get(rel) ?? [];
    const hoistTargets = sel.hoists.get(rel) ?? [];
    const fileBinds = sel.binds.get(rel) ?? [];
    if (tags.length === 0 && targets.length === 0 && hoistTargets.length === 0 && fileBinds.length === 0) continue;
    // Collection bindings are dynamic data-caret attributes — they splice exactly
    // like data-caret tags, so they ride the same offset-ordered tag pass.
    const tagSplices = [
      ...tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
      ...fileBinds.map((b) => ({ startOffset: b.startOffset, attribute: b.attribute })),
    ];
    prepared.push(
      await prepareFileFull(rel, readSource(root, rel), tagSplices, targets, hoistTargets),
    );
  }
  return prepared;
}

/** Tally what was actually written and print the closing summary. */
function printCommit(
  written: string[],
  hadBackups: boolean,
  prepared: PreparedFile[],
  sel: Selection,
  plans: FilePlan[],
): void {
  const changes = prepared
    .filter((p) => written.includes(p.relPath))
    .reduce((n, p) => n + p.tagCount, 0);
  const wrapped = written.reduce((n, rel) => n + (sel.wraps.get(rel)?.length ?? 0), 0);
  const hoisted = written.reduce(
    (n, rel) => n + (sel.hoists.get(rel)?.reduce((m, t) => m + t.props.length, 0) ?? 0), 0,
  );
  const bound = written.reduce((n, rel) => n + (sel.binds.get(rel)?.length ?? 0), 0);
  const flagged = plans.reduce((n, p) => n + p.flags.length, 0);
  process.stdout.write(formatSummary(written.length, changes, wrapped, hoisted, flagged, hadBackups, bound));
}

interface EscalationCtx {
  root: string;
  files: string[];
  basePlanOpts: PlanOptions;
  readFileSafe: FileReader;
  noProps: boolean;
  minConfidenceBase: Confidence;
}

/** Ask the top-level [Y/n/customize] choice (re-prompting on garbage) and return
 *  the tier ids the user newly accepts. `counts` is already offerable (tiers
 *  already on have been zeroed), so this only ever offers genuinely-new tiers. */
async function askEscalationAnswer(rl: Readline, counts: Record<TierId, number>): Promise<TierId[]> {
  const bundle = recommendedBundle(counts);
  const bundleLabels = bundle.map((id) => tierById(id).label).join(", ");
  let top = parseAnswer(await ask(rl, `\n  Include ${bundleLabels}? [Y/n/customize] `));
  while (top === "unknown") {
    process.stdout.write("  please answer y, n, or c(ustomize)\n");
    top = parseAnswer(await ask(rl, "  [Y/n/customize] "));
  }
  if (top === "no") return [];
  if (top === "yes") return bundle;
  // customize: ask per offered tier; blank keeps the tier's recommendation.
  const picked: TierId[] = [];
  for (const id of offeredTiers(counts)) {
    const t = tierById(id);
    const def = t.recommended ? "Y/n" : "y/N";
    const on = parseToggle(await ask(rl, `    include ${t.label} (${counts[id]})? [${def}] `), t.recommended);
    if (on) picked.push(id);
  }
  return picked;
}

/**
 * The in-flow escalation step (interactive only). After the conservative review,
 * offer the opt-in tiers as ONE grouped prompt; on accept, re-analyze gated to
 * exactly the chosen tiers and merge the escalation delta into the reviewed
 * selection.
 *
 * The detection here is the "detect-always" the prompt needs, but it lives only
 * in this interactive branch — it never widens what `-y` / `--dry-run` apply
 * (those skip this path). The re-analysis is gated to the user's chosen tiers,
 * so the safety/regression contract from Phase A holds. Returns the (possibly
 * augmented) selection, the plans to summarize, and the tiers actually applied.
 */
async function offerEscalation(
  ctx: EscalationCtx,
  active: Set<TierId>,
  analysis: Analysis,
  sel: Selection,
): Promise<{ sel: Selection; plans: FilePlan[]; tiers: Set<TierId> }> {
  // No new tiers accepted → keep the Phase A set (which the conservative pass
  // already applied + the user reviewed). Returning `active`, not an empty set,
  // keeps the closing hint honest when individual flags were combined with the
  // interactive run.
  const unchanged = { sel, plans: analysis.plans, tiers: active };

  // Detect-for-offer: collection + route bind targets (cheap, side-effect-free).
  // rich/lowconf counts come from the conservative analysis (rich-eligible skips
  // + belowConfidence), so no entangled rich pass is needed just to count. Tiers
  // already on (Phase A flags / --all) are zeroed — never offer what's applied.
  const offer = await analyzeFiles(
    ctx.root, ctx.files, ctx.basePlanOpts, ctx.readFileSafe, ctx.noProps, true, true,
  );
  const counts = offerableCounts(escalationCounts(analysis.plans, offer.bindsByFile), active);
  if (totalOffer(counts) === 0) return unchanged;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { process.stdout.write("\naborted — nothing written\n"); process.exit(130); });
  let chosenNew: TierId[];
  try {
    process.stdout.write(formatEscalationOffer(counts));
    process.stdout.write("  ⚠ = per-row binding that assumes each entry's .id is its identity\n");
    chosenNew = await askEscalationAnswer(rl, counts);
  } finally {
    rl.close();
  }

  if (chosenNew.length === 0) return unchanged;

  // Apply the union of the already-active tiers and the newly accepted ones, so
  // a Phase A flag is never silently dropped by the re-analysis.
  const effective = new Set<TierId>([...active, ...chosenNew]);

  // Re-analyze gated to exactly the effective tiers — one pass, so keys are
  // assigned coherently and the rich/low entanglement is correct (a rich host
  // suppresses its inline children rather than double-tagging them).
  const finalPlanOpts: PlanOptions = {
    ...ctx.basePlanOpts,
    rich: effective.has("rich") || effective.has("rich-class"),
    richClass: effective.has("rich-class"),
    minConfidence: effective.has("lowconf") ? "low" : ctx.minConfidenceBase,
  };
  const final = await analyzeFiles(
    ctx.root, ctx.files, finalPlanOpts, ctx.readFileSafe, ctx.noProps,
    effective.has("collections"), effective.has("routes"),
  );

  // Merge the escalation-only tags (rich + below-floor) into the reviewed set,
  // then re-key each touched file with the reviewed defaults claimed FIRST, so a
  // field name a default and an escalation tag both derive can't mint a duplicate
  // storage key (the run.ts gates accept duplicate keys — they're valid HTML).
  const delta = deltaTags(analysis.plans, final.plans);
  const mergedTags = mergeTagMaps(sel.tags, delta);
  const scopeByPath = new Map(final.plans.map((p) => [p.relPath, p.scope]));
  for (const rel of delta.keys()) {
    applyKeyRegistry(
      readSource(ctx.root, rel),
      scopeByPath.get(rel),
      mergedTags.get(rel) ?? [],
      sel.wraps.get(rel) ?? [],
      sel.hoists.get(rel) ?? [],
    );
  }

  const merged: Selection = {
    tags: mergedTags, wraps: sel.wraps, hoists: sel.hoists, binds: final.bindsByFile, quit: false,
  };
  return { sel: merged, plans: final.plans, tiers: effective };
}

/** Restore the most recent backup, reporting how many files came back. */
function runRestore(root: string): void {
  const restored = restoreLatest(root);
  process.stdout.write(
    restored.length
      ? `✓ restored ${restored.length} file(s):\n${restored.map((f) => `  ${f}`).join("\n")}\n`
      : "no backups found.\n",
  );
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliUsageError) fail(e.message);
    throw e;
  }
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }

  const root = process.cwd();

  if (args.restore) { runRestore(root); return; }

  const pf = preflight(root);
  for (const w of pf.warnings) process.stdout.write(`⚠ ${w}\n`);
  if (pf.errors.length) { for (const e of pf.errors) process.stderr.write(`✗ ${e}\n`); process.exit(1); }

  const files = discoverAstroFiles(root, args.target);

  // Resolve which opt-in tiers apply through the single policy function: the
  // individual flags, plus `--all` (every tier, incl. low-confidence). The CLI
  // never decides this inline — it only renders + applies what selectTiers
  // returns. Detection below stays gated by this set (no detect-always yet; the
  // in-flow prompt that needs it is a later step), so existing flag behavior is
  // byte-identical and `--all` simply turns the four tiers on at once.
  const intent: Intent = {
    all: args.all,
    flags: {
      collections: args.bindCollections,
      routes: args.bindRoutes,
      rich: args.rich,
      "rich-class": args.richClass,
      lowconf: args.minConfidence === "low",
    },
  };
  const tiers = selectTiers(intent);
  const bindCollections = tiers.has("collections");
  const bindRoutes = tiers.has("routes");
  const richClass = tiers.has("rich-class");
  const rich = tiers.has("rich") || richClass; // --rich-class implies --rich
  const minConfidence = tiers.has("lowconf") ? "low" : args.minConfidence;

  const planOpts: PlanOptions = {
    minConfidence,
    noImages: args.noImages,
    rich,
    richClass,
    scope: args.scope,
  };

  process.stdout.write(`caretize · scanning ${args.target ?? "src/"}\n`);
  // A child file that can't be read (any reason) conservatively yields null, so
  // the cross-file prop pass simply skips that hand-off rather than guessing.
  const readFileSafe: FileReader = (rel) => {
    try {
      return readSource(root, rel);
    } catch {
      return null;
    }
  };

  const analysis = await analyzeFiles(root, files, planOpts, readFileSafe, args.noProps, bindCollections, bindRoutes);
  // A re-run signal: elements the scan skipped because they already carry a
  // data-caret. Lets the scan line read as incremental ("N new … · M already
  // editable") rather than a cold scan.
  const priorTagged = analysis.plans.reduce(
    (n, p) => n + p.skipped.filter((s) => s.reason === "already-tagged").length, 0,
  );
  process.stdout.write(
    formatScanSummary(files.length, analysis.plans, analysis.wrapsByFile, analysis.hoistsByFile, analysis.bindsByFile, priorTagged),
  );

  let sel = await selectChanges(args, analysis);
  if (sel.quit) {
    process.stdout.write("\naborted — nothing written\n");
    return;
  }

  // Interactive only: after the conservative review, offer the opt-in tiers
  // in-flow so a first-timer reaches full coverage in one command — never asked
  // to learn the four tier flags. `-y` / `--dry-run` / non-TTY skip this and
  // keep Phase A's gated behavior.
  let summaryPlans = analysis.plans;
  let effectiveTiers = tiers;
  const interactive = !args.dryRun && !args.yes && !args.diff && process.stdin.isTTY && process.stdout.isTTY;
  // Optimistic default: applied without a per-file gate → show the diff after and
  // point at undo. (--review opts out of optimistic, so it doesn't re-show it.)
  const optimistic = interactive && !args.review;
  if (interactive) {
    const esc = await offerEscalation(
      { root, files, basePlanOpts: planOpts, readFileSafe, noProps: args.noProps, minConfidenceBase: args.minConfidence },
      tiers, analysis, sel,
    );
    sel = esc.sel;
    summaryPlans = esc.plans;
    effectiveTiers = esc.tiers;
  }

  const hintOpts: HintOpts = {
    rich: effectiveTiers.has("rich"),
    richClass: effectiveTiers.has("rich-class"),
    collections: effectiveTiers.has("collections"),
    routes: effectiveTiers.has("routes"),
    lowconf: effectiveTiers.has("lowconf"),
  };

  const prepared = await prepareTouched(root, sel);

  if (args.report) {
    writeFileSync(args.report, JSON.stringify(buildReport(analysis.plans, prepared), null, 2));
    process.stdout.write(`⤓ report → ${relative(root, args.report) || args.report}\n`);
  }

  if (args.diff) {
    process.stdout.write(formatDiff(prepared));
    process.stdout.write(formatFailures(prepared));
    process.stdout.write(formatHints(summaryPlans, hintOpts));
    return;
  }

  if (args.dryRun) {
    process.stdout.write(formatPlan(analysis.plans, analysis.wrapsByFile, analysis.hoistsByFile, analysis.bindsByFile));
    process.stdout.write(formatFailures(prepared));
    process.stdout.write(formatHints(summaryPlans, hintOpts));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { written, backups } = commitRun(root, prepared, stamp);
  if (written.length === 0) {
    // Don't print the "click to edit" success footer for a no-op run — say
    // why nothing matched and which flag unlocks the skipped candidates.
    process.stdout.write("\nno changes written.\n");
    process.stdout.write(formatHints(summaryPlans, hintOpts));
    return;
  }
  if (optimistic) {
    // "Show, don't ask": surface exactly what was just written, then make undo
    // the most visible next move.
    process.stdout.write("\napplied — here's what changed:\n");
    process.stdout.write(formatDiff(prepared));
  }
  printCommit(written, backups.length > 0, prepared, sel, summaryPlans);
  process.stdout.write(formatNextStep(pf));
  process.stdout.write(formatHints(summaryPlans, hintOpts));
  if (optimistic) {
    process.stdout.write("\n  not what you wanted? caretize --restore  ·  approve each change next time? caretize --review\n");
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`caretize: ${(err as Error).message}\n`);
  process.exit(1);
});
