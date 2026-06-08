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
import { isValidField, type Scope } from "./name.js";
import type { Confidence } from "./detect.js";

const VERSION = "0.1.0";

interface Args {
  target?: string;
  dryRun: boolean;
  yes: boolean;
  minConfidence: Confidence;
  noImages: boolean;
  rich: boolean;
  noProps: boolean;
  scope?: Scope;
  report?: string;
  restore: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false, yes: false, minConfidence: "high",
    noImages: false, rich: false, noProps: false, restore: false, help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run": a.dryRun = true; break;
      case "-y": case "--yes": a.yes = true; break;
      case "--no-images": a.noImages = true; break;
      case "--no-props": a.noProps = true; break;
      case "--rich": a.rich = true; break;
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

const HELP = `caretize · make an Astro project editable (data-caret + editable())

Usage: caretize [path] [options]

  path                     file or directory to scan (default: src/)
  --dry-run                print the plan, write nothing
  -y, --yes                auto-accept all suggestions at/above min-confidence
  --min-confidence <lvl>   high (default) | medium | low
  --no-images              skip <img> elements
  --no-props               skip hoisting static component-prop strings to editable()
  --rich                   also tag mixed-content blocks whose markup is
                           sanitizer-safe inline formatting (data-caret-rich)
  --scope <collection::id> override the inferred scope
  --report <file>          write a JSON report
  --restore                restore the most recent backup, then exit
  -h, --help               show this help
  -v, --version            print version
`;

function tagLine(t: PlannedTag): string {
  const text = t.candidate.text.replace(/\s+/g, " ").slice(0, 50);
  const what = t.candidate.kind === "image" ? `src="${text}"` : `"${text}"`;
  const rich = t.candidate.rich ? " [rich]" : "";
  return `<${t.candidate.tag}>${rich} ${what}`;
}

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (ans) => res(ans.trim())));
}

interface Selection {
  tags: Map<string, PlannedTag[]>;
  wraps: Map<string, WrapTarget[]>;
  hoists: Map<string, PropHoistTarget[]>;
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
      const take: PlannedTag[] = [];
      let skipFile = false;
      for (let i = 0; i < plan.tags.length && !skipFile; i++) {
        const t = plan.tags[i];
        if (acceptAll) { take.push(t); continue; }
        process.stdout.write(
          `\n${plan.relPath}\n  ${tagLine(t)}\n  + data-caret="${t.binding}"  (${t.confidence})\n`,
        );
        const ans = (await ask(rl, "  [a]ccept [s]kip [e]dit [A]ll [S]kip-file [q]uit > ")) || "a";
        if (ans === "q") { tags.clear(); wraps.clear(); hoists.clear(); return { tags, wraps, hoists }; }
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
      if (take.length) tags.set(plan.relPath, take);

      if (fileWraps.length > 0 && !skipFile) {
        const names = fileWraps.map((w) => w.varName).join(", ");
        const ans = (await ask(
          rl,
          `\n${plan.relPath}\n  wrap ${fileWraps.length} data array(s) [${names}] with editable()? [Y/n] `,
        )) || "y";
        if (ans.toLowerCase() !== "n") wraps.set(plan.relPath, fileWraps);
      }

      if (fileHoists.length > 0 && !skipFile) {
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
            `\n${plan.relPath}\n  <${h.componentName}> — hoist ${h.props.length} prop(s) to editable()?\n${lines}\n  [Y/n] `,
          )) || "y";
          if (ans.toLowerCase() !== "n") take.push(h);
        }
        if (take.length) hoists.set(plan.relPath, take);
      }
    }
  } finally {
    rl.close();
  }
  return { tags, wraps, hoists };
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
  // Parse each file ONCE, then drive all three passes off that single AST:
  //   - planFile: the data-caret tag plan
  //   - detectWrapTargetsSafe: same-file data-array loops (Tier-1), dropped when a
  //     field would land in a native attribute
  //   - detectPropWrapTargets: literals passed to a component whose child provably
  //     renders them as text (Tier-2, cross-file)
  const plans: FilePlan[] = [];
  const wrapsByFile = new Map<string, WrapTarget[]>();
  const hoistsByFile = new Map<string, PropHoistTarget[]>();
  for (const rel of files) {
    const src = readSource(root, rel);
    const ast = await parseAstro(src);
    plans.push(await planFile(src, rel, planOpts, ast));

    const loops = await detectWrapTargetsSafe(src, rel, ast);
    const props = await detectPropWrapTargets(src, rel, readFileSafe, ast);
    const imports = await detectImportWrapTargetsSafe(src, rel, ast);
    const byName = new Map<string, WrapTarget>();
    for (const t of [...loops, ...props, ...imports]) byName.set(t.varName, t);
    if (byName.size) wrapsByFile.set(rel, [...byName.values()]);

    if (!args.noProps) {
      const hoists = await detectPropHoistTargets(src, rel, readFileSafe, ast);
      if (hoists.length) hoistsByFile.set(rel, hoists);
    }
  }

  const candidateTotal = plans.reduce((n, p) => n + p.tags.length, 0);
  const wrapTotal = [...wrapsByFile.values()].reduce((n, t) => n + t.length, 0);
  const hoistTotal = [...hoistsByFile.values()].reduce(
    (n, ts) => n + ts.reduce((m, t) => m + t.props.length, 0), 0,
  );
  process.stdout.write(
    `✓ ${files.length} .astro files · ${candidateTotal} tag candidate(s) · ${wrapTotal} wrap target(s) · ${hoistTotal} prop(s)\n`,
  );

  // Decide what to apply.
  let sel: Selection;
  const allTags = new Map(plans.map((p) => [p.relPath, p.tags] as [string, PlannedTag[]]));
  if (args.dryRun || args.yes) {
    sel = { tags: allTags, wraps: wrapsByFile, hoists: hoistsByFile };
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    sel = await review(plans, wrapsByFile, hoistsByFile);
  } else if (args.report) {
    sel = { tags: new Map(), wraps: new Map(), hoists: new Map() };
  } else {
    fail("non-interactive terminal: pass --dry-run, -y, or --report");
  }

  // Prepare (verify) every touched file in memory — tags + wraps + hoists together.
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

  if (args.report) {
    writeFileSync(args.report, JSON.stringify(buildReport(plans, prepared), null, 2));
    process.stdout.write(`⤓ report → ${relative(root, args.report) || args.report}\n`);
  }

  if (args.dryRun) {
    printPlan(plans, wrapsByFile, hoistsByFile);
    printHints(plans, args.rich);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { written, backups } = commitRun(root, prepared, stamp);
  const changes = prepared
    .filter((p) => written.includes(p.relPath))
    .reduce((n, p) => n + p.tagCount, 0);
  const wrapped = written.reduce((n, rel) => n + (sel.wraps.get(rel)?.length ?? 0), 0);
  const hoisted = written.reduce(
    (n, rel) => n + (sel.hoists.get(rel)?.reduce((m, t) => m + t.props.length, 0) ?? 0), 0,
  );
  const flagged = plans.reduce((n, p) => n + p.flags.length, 0);
  printSummary(written.length, changes, wrapped, hoisted, flagged, backups.length > 0);
  printHints(plans, args.rich);
}

/**
 * Surface the actionable skips — the "why isn't this editable?" answers — so a
 * skip reads as a checklist item, not a silent omission. Adapts to --rich:
 * rich-eligible blocks become tags under --rich (so they won't appear here),
 * while styled-inline blocks need allowedClasses or CSS regardless.
 */
function printHints(plans: FilePlan[], rich: boolean): void {
  let eligible = 0;
  let styled = 0;
  for (const p of plans) {
    for (const s of p.skipped) {
      if (s.reason === "rich-eligible") eligible++;
      else if (s.reason === "rich-unsafe-attrs") styled++;
    }
  }
  if (eligible && !rich) {
    process.stdout.write(
      `\n↪ ${eligible} mixed-content block(s) are sanitizer-safe inline markup — re-run with --rich to make them editable.\n`,
    );
  }
  if (styled) {
    process.stdout.write(
      `↪ ${styled} block(s) hold inline styling classes the rich-text sanitizer strips on save.\n` +
        `  Move the styling to CSS (style the semantic tag), or bless the class via\n` +
        `  caret({ allowedClasses: { tag: ["your-class"] } }) — then they're safe to tag.\n`,
    );
  }
}

function printPlan(
  plans: FilePlan[],
  wrapsByFile: Map<string, WrapTarget[]>,
  hoistsByFile: Map<string, PropHoistTarget[]>,
): void {
  for (const plan of plans) {
    const wraps = wrapsByFile.get(plan.relPath) ?? [];
    const hoists = hoistsByFile.get(plan.relPath) ?? [];
    if (plan.tags.length === 0 && plan.flags.length === 0 && wraps.length === 0 && hoists.length === 0) continue;
    process.stdout.write(`\n${plan.relPath}${plan.scopeSkip ? `  (skipped: ${plan.scopeSkip})` : ""}\n`);
    for (const t of plan.tags) process.stdout.write(`  + data-caret="${t.binding}"  ${tagLine(t)}\n`);
    for (const w of wraps) {
      const via = w.origin === "prop" ? " (via component prop)" : w.origin === "import" ? " (via data import)" : "";
      const kind = w.origin === "import" ? "import" : "const";
      process.stdout.write(`  ~ editable("${w.key}")  wrap ${kind} ${w.varName}${via}\n`);
    }
    for (const h of hoists) {
      for (const p of h.props) {
        process.stdout.write(`  ⤴ editable("${p.key}")  hoist <${h.componentName}> ${p.propName}${p.isRich ? " [rich]" : ""}\n`);
      }
    }
    for (const f of plan.flags) process.stdout.write(`  ⚠ ${f.method}() loop — consider a dynamic collection\n`);
  }
  process.stdout.write("\n(dry run — nothing written)\n");
}

function printSummary(
  files: number,
  changes: number,
  wrapped: number,
  hoisted: number,
  flagged: number,
  hadBackups: boolean,
): void {
  process.stdout.write(`\n───────────────────────────────\n`);
  process.stdout.write(`✓ ${changes} change(s) across ${files} file(s)\n`);
  if (wrapped) process.stdout.write(`✓ ${wrapped} data array(s) wrapped with editable()\n`);
  if (hoisted) process.stdout.write(`✓ ${hoisted} component prop(s) hoisted to editable()\n`);
  if (flagged) process.stdout.write(`⚠ ${flagged} loop(s) flagged → consider dynamic collections\n`);
  if (hadBackups) process.stdout.write(`⤺ backups in .caret/.caretize-bak/ (caretize --restore to undo)\n`);
  process.stdout.write(`───────────────────────────────\nNext: npm run dev → open your page → click to edit\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`caretize: ${(err as Error).message}\n`);
  process.exit(1);
});
