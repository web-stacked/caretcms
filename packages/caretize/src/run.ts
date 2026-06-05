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
import { wrapConst } from "./wrap.js";
import { writeBackup, restoreLatest } from "./backup.js";

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

export interface WrapTarget {
  /** Frontmatter const/let/var to wrap. */
  varName: string;
  /** Binding key, e.g. `pages::home::services`. */
  key: string;
}

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
    const result = wrapConst(output, t.varName, t.key);
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
