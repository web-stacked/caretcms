#!/usr/bin/env node
/**
 * caretize CLI — scan an Astro project and add `data-caret` attributes.
 *
 * Thin shell over the engine (discover → plan → prepare → commit). All the
 * load-bearing logic lives in the tested modules; this file is argument
 * parsing, the interactive review loop, and output formatting.
 */

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { discoverAstroFiles } from "./discover.js";
import { preflight } from "./preflight.js";
import { planFile, type FilePlan, type PlannedTag, type PlanOptions } from "./plan.js";
import { prepareFile, commitRun, readSource, type PreparedFile } from "./run.js";
import { restoreLatest } from "./backup.js";
import { buildReport } from "./report.js";
import { isValidField, type Scope } from "./name.js";
import type { Confidence } from "./detect.js";

const VERSION = "0.1.0";

interface Args {
  target?: string;
  dryRun: boolean;
  yes: boolean;
  minConfidence: Confidence;
  noImages: boolean;
  scope?: Scope;
  report?: string;
  restore: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false, yes: false, minConfidence: "high",
    noImages: false, restore: false, help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run": a.dryRun = true; break;
      case "-y": case "--yes": a.yes = true; break;
      case "--no-images": a.noImages = true; break;
      case "--restore": a.restore = true; break;
      case "--help": case "-h": a.help = true; break;
      case "--version": case "-v": a.version = true; break;
      case "--min-confidence": {
        const v = argv[++i];
        if (v !== "high" && v !== "medium" && v !== "low") fail(`--min-confidence must be high|medium|low`);
        a.minConfidence = v;
        break;
      }
      case "--scope": {
        const v = argv[++i] ?? "";
        const [collection, id] = v.split("::");
        if (!collection || !id) fail(`--scope must be "collection::id"`);
        a.scope = { collection, id };
        break;
      }
      case "--report": a.report = argv[++i]; break;
      default:
        if (arg.startsWith("-")) fail(`unknown flag: ${arg}`);
        a.target = arg;
    }
  }
  return a;
}

function fail(msg: string): never {
  process.stderr.write(`caretize: ${msg}\n`);
  process.exit(2);
}

const HELP = `caretize · add data-caret attributes to an Astro project

Usage: caretize [path] [options]

  path                     file or directory to scan (default: src/)
  --dry-run                print the plan, write nothing
  -y, --yes                auto-accept all suggestions at/above min-confidence
  --min-confidence <lvl>   high (default) | medium | low
  --no-images              skip <img> elements
  --scope <collection::id> override the inferred scope
  --report <file>          write a JSON report
  --restore                restore the most recent backup, then exit
  -h, --help               show this help
  -v, --version            print version
`;

function tagLine(t: PlannedTag): string {
  const text = t.candidate.text.replace(/\s+/g, " ").slice(0, 50);
  const what = t.candidate.kind === "image" ? `src="${text}"` : `"${text}"`;
  return `<${t.candidate.tag}> ${what}`;
}

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (ans) => res(ans.trim())));
}

/** Interactive per-candidate review. Returns the accepted tags per file. */
async function review(plans: FilePlan[]): Promise<Map<string, PlannedTag[]>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const accepted = new Map<string, PlannedTag[]>();
  let acceptAll = false;
  try {
    for (const plan of plans) {
      if (plan.tags.length === 0) continue;
      const take: PlannedTag[] = [];
      let skipFile = false;
      for (let i = 0; i < plan.tags.length && !skipFile; i++) {
        const t = plan.tags[i];
        if (acceptAll) { take.push(t); continue; }
        process.stdout.write(
          `\n${plan.relPath}\n  ${tagLine(t)}\n  + data-caret="${t.binding}"  (${t.confidence})\n`,
        );
        const ans = (await ask(rl, "  [a]ccept [s]kip [e]dit [A]ll [S]kip-file [q]uit > ")) || "a";
        if (ans === "q") { accepted.clear(); return accepted; }
        if (ans === "S") { skipFile = true; break; }
        if (ans === "A") { acceptAll = true; take.push(t); continue; }
        if (ans === "s") continue;
        if (ans === "e") {
          const field = await ask(rl, `  new field name (${t.field}): `);
          if (field && isValidField(field)) {
            take.push({ ...t, field, binding: `${t.collection}::${t.id}::${field}`, attribute: `data-caret="${t.collection}::${t.id}::${field}"` });
          } else {
            process.stdout.write(field ? "  invalid field name; skipped\n" : "  kept original\n");
            if (!field) take.push(t);
          }
          continue;
        }
        take.push(t); // default accept
      }
      if (take.length) accepted.set(plan.relPath, take);
    }
  } finally {
    rl.close();
  }
  return accepted;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }

  const root = process.cwd();

  if (args.restore) {
    const restored = restoreLatest(root);
    process.stdout.write(
      restored.length
        ? `✓ restored ${restored.length} file(s):\n${restored.map((f) => `  ${f}`).join("\n")}\n`
        : "no backups found.\n",
    );
    return;
  }

  const pf = preflight(root);
  for (const w of pf.warnings) process.stdout.write(`⚠ ${w}\n`);
  if (pf.errors.length) { for (const e of pf.errors) process.stderr.write(`✗ ${e}\n`); process.exit(1); }

  const files = discoverAstroFiles(root, args.target);
  const planOpts: PlanOptions = {
    minConfidence: args.minConfidence,
    noImages: args.noImages,
    scope: args.scope,
  };

  process.stdout.write(`caretize · scanning ${args.target ?? "src/"}\n`);
  const plans: FilePlan[] = [];
  for (const rel of files) {
    plans.push(await planFile(readSource(root, rel), rel, planOpts));
  }
  const candidateTotal = plans.reduce((n, p) => n + p.tags.length, 0);
  process.stdout.write(`✓ ${files.length} .astro files · ${candidateTotal} candidate(s)\n`);

  // Decide which tags to apply.
  let selection: Map<string, PlannedTag[]>;
  if (args.dryRun) {
    selection = new Map(plans.map((p) => [p.relPath, p.tags]));
  } else if (args.yes) {
    selection = new Map(plans.map((p) => [p.relPath, p.tags]));
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    selection = await review(plans);
  } else if (args.report) {
    selection = new Map(); // report-only in non-interactive mode
  } else {
    fail("non-interactive terminal: pass --dry-run, -y, or --report");
  }

  // Prepare (verify) every selected file in memory.
  const prepared: PreparedFile[] = [];
  for (const plan of plans) {
    const tags = selection.get(plan.relPath) ?? [];
    if (tags.length === 0) continue;
    prepared.push(
      await prepareFile(plan.relPath, readSource(root, plan.relPath),
        tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute }))),
    );
  }

  if (args.report) {
    writeFileSync(args.report, JSON.stringify(buildReport(plans, prepared), null, 2));
    process.stdout.write(`⤓ report → ${relative(root, args.report) || args.report}\n`);
  }

  if (args.dryRun) {
    printPlan(plans);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { written, backups } = commitRun(root, prepared, stamp);
  printSummary(plans, written, backups.length > 0);
}

function printPlan(plans: FilePlan[]): void {
  for (const plan of plans) {
    if (plan.tags.length === 0 && plan.flags.length === 0) continue;
    process.stdout.write(`\n${plan.relPath}${plan.scopeSkip ? `  (skipped: ${plan.scopeSkip})` : ""}\n`);
    for (const t of plan.tags) process.stdout.write(`  + data-caret="${t.binding}"  ${tagLine(t)}\n`);
    for (const f of plan.flags) process.stdout.write(`  ⚠ ${f.method}() loop — consider a dynamic collection\n`);
  }
  process.stdout.write("\n(dry run — nothing written)\n");
}

function printSummary(plans: FilePlan[], written: string[], hadBackups: boolean): void {
  const tagged = written.reduce(
    (n, rel) => n + (plans.find((p) => p.relPath === rel)?.tags.length ?? 0), 0);
  const flagged = plans.reduce((n, p) => n + p.flags.length, 0);
  process.stdout.write(`\n───────────────────────────────\n`);
  process.stdout.write(`✓ ${tagged} tagged across ${written.length} file(s)\n`);
  if (flagged) process.stdout.write(`⚠ ${flagged} loop(s) flagged → consider dynamic collections\n`);
  if (hadBackups) process.stdout.write(`⤺ backups in .caret/.caretize-bak/ (caretize --restore to undo)\n`);
  process.stdout.write(`───────────────────────────────\nNext: npm run dev → open your page → click to edit\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`caretize: ${(err as Error).message}\n`);
  process.exit(1);
});
