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
import { detectImportWrapTargetsSafe } from "./import-wrap.js";
import { detectPropWrapTargets, type FileReader } from "./props.js";
import { detectPropHoistTargets, type PropHoistTarget } from "./prop-hoist.js";
import { restoreLatest } from "./backup.js";
import { buildReport } from "./report.js";
import { isValidField } from "./name.js";
import { parseArgs, CliUsageError, HELP, type Args } from "./cli-args.js";
import { tagLine, formatScanSummary, formatPlan, formatSummary, formatHints } from "./output.js";

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

/** Per-candidate prompt for one file. Returns the accepted tags plus control
 *  signals: `quit` aborts the whole run, `skipFile` skips this file's wrap/hoist
 *  prompts, and `acceptAll` carries the sticky [A]ll choice on to later files. */
async function reviewFileTags(
  rl: Readline,
  plan: FilePlan,
  acceptAll: boolean,
): Promise<{ take: PlannedTag[]; skipFile: boolean; quit: boolean; acceptAll: boolean }> {
  const take: PlannedTag[] = [];
  let skipFile = false;
  for (let i = 0; i < plan.tags.length && !skipFile; i++) {
    const t = plan.tags[i];
    if (acceptAll) { take.push(t); continue; }
    process.stdout.write(
      `\n${plan.relPath}\n  ${tagLine(t)}\n  + data-caret="${t.binding}"  (${t.confidence})\n`,
    );
    const ans = (await ask(rl, "  [a]ccept [s]kip [e]dit [A]ll [S]kip-file [q]uit > ")) || "a";
    if (ans === "q") return { take, skipFile, quit: true, acceptAll };
    if (ans === "S") { skipFile = true; break; }
    if (ans === "A") { acceptAll = true; take.push(t); continue; }
    if (ans === "s") continue;
    if (ans === "e") { const edited = await editField(rl, t); if (edited) take.push(edited); continue; }
    take.push(t); // default accept
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

/** Interactive review: per-candidate tags, then per-file wrap + prop-hoist confirms. */
async function review(
  plans: FilePlan[],
  wrapsByFile: Map<string, WrapTarget[]>,
  hoistsByFile: Map<string, PropHoistTarget[]>,
): Promise<Selection> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const tags = new Map<string, PlannedTag[]>();
  const wraps = new Map<string, WrapTarget[]>();
  const hoists = new Map<string, PropHoistTarget[]>();
  let acceptAll = false;
  try {
    for (const plan of plans) {
      const fileWraps = wrapsByFile.get(plan.relPath) ?? [];
      const fileHoists = hoistsByFile.get(plan.relPath) ?? [];
      if (plan.tags.length === 0 && fileWraps.length === 0 && fileHoists.length === 0) continue;

      const res = await reviewFileTags(rl, plan, acceptAll);
      acceptAll = res.acceptAll;
      if (res.quit) { tags.clear(); wraps.clear(); hoists.clear(); return { tags, wraps, hoists }; }
      if (res.take.length) tags.set(plan.relPath, res.take);
      if (res.skipFile) continue;

      if (fileWraps.length > 0 && (await confirmWraps(rl, plan.relPath, fileWraps))) {
        wraps.set(plan.relPath, fileWraps);
      }
      if (fileHoists.length > 0) {
        const take = await confirmHoists(rl, plan.relPath, fileHoists);
        if (take.length) hoists.set(plan.relPath, take);
      }
    }
  } finally {
    rl.close();
  }
  return { tags, wraps, hoists };
}

interface Analysis {
  plans: FilePlan[];
  wrapsByFile: Map<string, WrapTarget[]>;
  hoistsByFile: Map<string, PropHoistTarget[]>;
}

/**
 * Parse each file ONCE, then drive all detection passes off that single AST:
 *   - planFile: the data-caret tag plan
 *   - detectWrapTargetsSafe: same-file data-array loops (Tier-1), dropped when a
 *     field would land in a native attribute
 *   - detectPropWrapTargets: literals passed to a component whose child provably
 *     renders them as text (Tier-2, cross-file)
 *   - detectImportWrapTargetsSafe: arrays pulled in from a data import (Tier-3)
 *   - detectPropHoistTargets: static component-prop strings (unless --no-props)
 */
async function analyzeFiles(
  root: string,
  files: string[],
  planOpts: PlanOptions,
  readFileSafe: FileReader,
  noProps: boolean,
): Promise<Analysis> {
  const plans: FilePlan[] = [];
  const wrapsByFile = new Map<string, WrapTarget[]>();
  const hoistsByFile = new Map<string, PropHoistTarget[]>();
  for (const rel of files) {
    const src = readSource(root, rel);
    const ast = await parseAstro(src);
    const plan = await planFile(src, rel, planOpts, ast);
    plans.push(plan);

    const loops = await detectWrapTargetsSafe(src, rel, ast);
    const props = await detectPropWrapTargets(src, rel, readFileSafe, ast);
    const imports = await detectImportWrapTargetsSafe(src, rel, ast);
    const byName = new Map<string, WrapTarget>();
    for (const t of [...loops, ...props, ...imports]) byName.set(t.varName, t);
    if (byName.size) wrapsByFile.set(rel, [...byName.values()]);

    // A loop whose receiver a wrap tier just made editable (Tier-1/Tier-3) no
    // longer warrants the "consider a dynamic collection" flag — suppress it so
    // we don't tell the user to rethink a loop we covered in place.
    plan.flags = plan.flags.filter((f) => !f.receiver || !byName.has(f.receiver));

    if (!noProps) {
      const hoists = await detectPropHoistTargets(src, rel, readFileSafe, ast);
      if (hoists.length) hoistsByFile.set(rel, hoists);
    }
  }
  return { plans, wrapsByFile, hoistsByFile };
}

/** Decide what to apply: everything (dry-run / -y), the interactive review, or
 *  nothing (report-only). Errors out on a non-interactive run with no directive. */
async function selectChanges(args: Args, a: Analysis): Promise<Selection> {
  if (args.dryRun || args.yes) {
    const allTags = new Map(a.plans.map((p) => [p.relPath, p.tags] as [string, PlannedTag[]]));
    return { tags: allTags, wraps: a.wrapsByFile, hoists: a.hoistsByFile };
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return review(a.plans, a.wrapsByFile, a.hoistsByFile);
  }
  if (args.report) return { tags: new Map(), wraps: new Map(), hoists: new Map() };
  fail("non-interactive terminal: pass --dry-run, -y, or --report");
}

/** Prepare (verify) every touched file in memory — tags + wraps + hoists together. */
async function prepareTouched(root: string, sel: Selection): Promise<PreparedFile[]> {
  const touched = new Set<string>([
    ...sel.tags.keys(), ...sel.wraps.keys(), ...sel.hoists.keys(),
  ]);
  const prepared: PreparedFile[] = [];
  for (const rel of touched) {
    const tags = sel.tags.get(rel) ?? [];
    const targets = sel.wraps.get(rel) ?? [];
    const hoistTargets = sel.hoists.get(rel) ?? [];
    if (tags.length === 0 && targets.length === 0 && hoistTargets.length === 0) continue;
    prepared.push(
      await prepareFileFull(
        rel,
        readSource(root, rel),
        tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
        targets,
        hoistTargets,
      ),
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
  const flagged = plans.reduce((n, p) => n + p.flags.length, 0);
  process.stdout.write(formatSummary(written.length, changes, wrapped, hoisted, flagged, hadBackups));
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
  const planOpts: PlanOptions = {
    minConfidence: args.minConfidence,
    noImages: args.noImages,
    rich: args.rich,
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

  const analysis = await analyzeFiles(root, files, planOpts, readFileSafe, args.noProps);
  process.stdout.write(
    formatScanSummary(files.length, analysis.plans, analysis.wrapsByFile, analysis.hoistsByFile),
  );

  const sel = await selectChanges(args, analysis);
  const prepared = await prepareTouched(root, sel);

  if (args.report) {
    writeFileSync(args.report, JSON.stringify(buildReport(analysis.plans, prepared), null, 2));
    process.stdout.write(`⤓ report → ${relative(root, args.report) || args.report}\n`);
  }

  if (args.dryRun) {
    process.stdout.write(formatPlan(analysis.plans, analysis.wrapsByFile, analysis.hoistsByFile));
    process.stdout.write(formatHints(analysis.plans, args.rich));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { written, backups } = commitRun(root, prepared, stamp);
  printCommit(written, backups.length > 0, prepared, sel, analysis.plans);
  process.stdout.write(formatHints(analysis.plans, args.rich));
}

main().catch((err: unknown) => {
  process.stderr.write(`caretize: ${(err as Error).message}\n`);
  process.exit(1);
});
