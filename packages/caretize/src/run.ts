/**
 * Run orchestration. The atomicity model is "validate everything in memory,
 * then write": every file's tagged output is computed and verified (re-parses +
 * is pure-insertion-reversible) BEFORE a single byte hits disk. If any file
 * fails verification, the run aborts having written nothing. During the write
 * phase, backups are taken per file; if a write throws, everything written so
 * far is restored from those backups.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAstro } from "./parse.js";
import { applyTags, type TagInsertion } from "./write.js";
import { wrapConst, type WrapTarget } from "./wrap.js";
import { wrapImport } from "./import-wrap.js";
import { hoistPropLiterals, verifyHoistResult, type PropHoistTarget } from "./prop-hoist.js";
import { writeBackup, restoreLatest } from "./backup.js";

/** Apply the right editable() wrap for a target's origin. */
function applyWrap(source: string, t: WrapTarget) {
  return t.origin === "import"
    ? wrapImport(source, t.varName, t.key)
    : wrapConst(source, t.varName, t.key);
}

export interface PreparedFile {
  relPath: string;
  source: string;
  output: string;
  inserted: string[];
  tagCount: number;
  ok: boolean;
  reason?: string;
}

/** Compute and verify a single file's tagged output. No disk access. */
export async function prepareFile(
  relPath: string,
  source: string,
  items: TagInsertion[],
): Promise<PreparedFile> {
  const base: PreparedFile = {
    relPath, source, output: source, inserted: [], tagCount: 0, ok: true,
  };
  if (items.length === 0) return base;

  const { output, inserted, failures } = applyTags(source, items);
  if (failures.length > 0) {
    return { ...base, ok: false, reason: `could not place ${failures.length} tag(s)` };
  }

  // Gate 1: the result must still be valid Astro.
  try {
    await parseAstro(output);
  } catch (err) {
    return { ...base, ok: false, reason: `output failed to re-parse: ${(err as Error).message}` };
  }

  // Gate 2: pure-insertion — stripping the inserted attrs restores the original.
  let restored = output;
  for (const attr of inserted) {
    const idx = restored.indexOf(attr);
    if (idx < 0) return { ...base, ok: false, reason: "inserted attribute not found on verify" };
    restored = restored.slice(0, idx) + restored.slice(idx + attr.length);
  }
  if (restored !== source) {
    return { ...base, ok: false, reason: "output is not a pure insertion of the original" };
  }

  return { relPath, source, output, inserted, tagCount: items.length, ok: true };
}

export type { WrapTarget };

/** True when every character of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Compute and verify a single file's editable()-wrapped output (Tier-1). Same
 * atomicity contract as prepareFile, so the result feeds commitRun unchanged.
 *
 * Gate 2 here is a SUBSEQUENCE check rather than strip-by-string: the inserted
 * `await editable(…, ` / `)` spans contain characters (`)`, commas) that also
 * occur elsewhere, so verifying "original is a subsequence of output" is the
 * robust way to prove pure insertion (no original char deleted or reordered).
 */
export async function prepareWrapFile(
  relPath: string,
  source: string,
  targets: WrapTarget[],
): Promise<PreparedFile> {
  const base: PreparedFile = {
    relPath, source, output: source, inserted: [], tagCount: 0, ok: true,
  };
  if (targets.length === 0) return base;

  let output = source;
  const inserted: string[] = [];
  for (const t of targets) {
    const result = applyWrap(output, t);
    if (!result.ok) return { ...base, ok: false, reason: `${t.varName}: ${result.reason}` };
    if (result.alreadyWrapped) continue;
    inserted.push(`editable(${JSON.stringify(t.key)}) around ${t.varName}`);
    output = result.output;
  }
  if (inserted.length === 0) return base; // nothing applicable (already wrapped)

  // Gate 1: the result must still be valid Astro.
  try {
    await parseAstro(output);
  } catch (err) {
    return { ...base, ok: false, reason: `output failed to re-parse: ${(err as Error).message}` };
  }

  // Gate 2: pure insertion — every original character survives, in order.
  if (!isSubsequence(source, output)) {
    return { ...base, ok: false, reason: "output is not a pure insertion of the original" };
  }

  return { relPath, source, output, inserted, tagCount: inserted.length, ok: true };
}

/**
 * Compute and verify a file's output with BOTH passes: attribute tags and
 * editable() wraps. Tags are applied first (offset-based, in the template), then
 * wraps (content-scan, in the frontmatter) — so the frontmatter insertions never
 * shift the template tag offsets. Same atomicity gates; one PreparedFile out.
 */
export async function prepareFileFull(
  relPath: string,
  source: string,
  items: TagInsertion[],
  targets: WrapTarget[],
  hoistTargets: PropHoistTarget[] = [],
): Promise<PreparedFile> {
  const base: PreparedFile = {
    relPath, source, output: source, inserted: [], tagCount: 0, ok: true,
  };
  if (items.length === 0 && targets.length === 0 && hoistTargets.length === 0) return base;

  let output = source;
  const inserted: string[] = [];

  // Pass 1: attribute tags (template).
  if (items.length > 0) {
    const tagged = applyTags(source, items);
    if (tagged.failures.length > 0) {
      return { ...base, ok: false, reason: `could not place ${tagged.failures.length} tag(s)` };
    }
    output = tagged.output;
    inserted.push(...tagged.inserted);
  }

  // Pass 2: editable() wraps (frontmatter) — wrapConst for consts, wrapImport
  // for default data imports. Both are pure insertion.
  let wrapCount = 0;
  for (const t of targets) {
    const wrapped = applyWrap(output, t);
    if (!wrapped.ok) return { ...base, ok: false, reason: `${t.varName}: ${wrapped.reason}` };
    if (wrapped.alreadyWrapped) continue;
    inserted.push(`editable(${JSON.stringify(t.key)}) around ${t.varName}`);
    output = wrapped.output;
    wrapCount++;
  }

  if (output === source && hoistTargets.length === 0) return base; // nothing changed

  // Passes 1+2 are pure insertion: verify the running output is a subsequence of
  // the original BEFORE the (deletion-bearing) hoist pass runs.
  const afterWraps = output;
  if (!isSubsequence(source, afterWraps)) {
    return { ...base, ok: false, reason: "output is not a pure insertion of the original" };
  }

  // Pass 3 (LAST): prop-hoist rewrite. Self-locating, so it runs after the
  // offset-based tag pass. Verified by an inverse gate against `afterWraps`.
  let hoistCount = 0;
  if (hoistTargets.length > 0) {
    const h = hoistPropLiterals(afterWraps, hoistTargets);
    if (!h.ok) return { ...base, ok: false, reason: `hoist: ${h.reason}` };
    if (h.propsRewritten > 0) {
      if (!verifyHoistResult(afterWraps, h.output, hoistTargets, h.addedImport)) {
        return { ...base, ok: false, reason: "hoist not reversible to pre-hoist source" };
      }
      output = h.output;
      hoistCount = h.propsRewritten;
      inserted.push(...h.constsDeclared.map((c) => `editable() hoist → const ${c}`));
    }
  }

  if (output === source) return base; // nothing actually changed

  // Gate 1: still valid Astro.
  try {
    await parseAstro(output);
  } catch (err) {
    return { ...base, ok: false, reason: `output failed to re-parse: ${(err as Error).message}` };
  }

  return {
    relPath, source, output, inserted,
    tagCount: items.length + wrapCount + hoistCount, ok: true,
  };
}

export interface CommitResult {
  written: string[];
  backups: string[];
}

/**
 * Write verified files to disk with backups. Throws (after rolling back) if any
 * prepared file failed verification or any write fails.
 */
export function commitRun(
  rootDir: string,
  prepared: PreparedFile[],
  stamp: string,
): CommitResult {
  const toWrite = prepared.filter((p) => p.tagCount > 0);

  const bad = toWrite.find((p) => !p.ok);
  if (bad) {
    throw new Error(`refusing to write: ${bad.relPath} failed verification (${bad.reason})`);
  }

  const written: string[] = [];
  const backups: string[] = [];
  try {
    for (const file of toWrite) {
      backups.push(writeBackup(rootDir, file.relPath, stamp));
      writeFileSync(resolve(rootDir, file.relPath), file.output, "utf8");
      written.push(file.relPath);
    }
  } catch (err) {
    // Roll back anything already written in this run.
    restoreLatest(rootDir);
    throw new Error(`write failed, rolled back: ${(err as Error).message}`);
  }

  return { written, backups };
}

/** Convenience: read a file from disk for preparation. */
export function readSource(rootDir: string, relPath: string): string {
  return readFileSync(resolve(rootDir, relPath), "utf8");
}
