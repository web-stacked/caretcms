/**
 * Backups + restore. Before any file is modified, its current bytes are copied
 * to `.caret/.caretize-bak/<relpath>.<timestamp>.bak`, and a hash of what
 * caretize then wrote is kept beside the backup. `--restore` rolls the most
 * recent run back, but only for files that are still exactly what caretize
 * wrote: a file edited since is never overwritten with its old bytes.
 *
 * The timestamp is injected (not read from the clock here) so a single run uses
 * one consistent stamp across all files and the logic stays deterministic/
 * testable.
 */

import {
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  copyFileSync as cp,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const BAK_DIR = join(".caret", ".caretize-bak");

function backupRoot(rootDir: string): string {
  return resolve(rootDir, BAK_DIR);
}

/** Absolute backup path for a project-relative file at a given timestamp. */
function backupPathFor(rootDir: string, relPath: string, stamp: string): string {
  return join(backupRoot(rootDir), `${relPath}.${stamp}.bak`);
}

/** Copy the current file to its timestamped backup, creating dirs as needed. */
export function writeBackup(rootDir: string, relPath: string, stamp: string): string {
  const src = resolve(rootDir, relPath);
  const dest = backupPathFor(rootDir, relPath, stamp);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return dest;
}

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Remember what caretize wrote to a backed-up file, so a later restore can tell whether it was edited since. */
export function recordWritten(rootDir: string, relPath: string, stamp: string): void {
  writeFileSync(`${backupPathFor(rootDir, relPath, stamp)}.sha256`, hashOf(resolve(rootDir, relPath)), "utf8");
}

interface BackupEntry {
  relPath: string;
  stamp: string;
  backupAbs: string;
}

const BAK_RE = /^(.*)\.([0-9TZ:.\-]+)\.bak$/;

/** All backups under the backup root, parsed into {relPath, stamp}. */
export function listBackups(rootDir: string): BackupEntry[] {
  const root = backupRoot(rootDir);
  if (!existsSync(root)) return [];
  const out: BackupEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      const m = BAK_RE.exec(name);
      if (!m) continue;
      const relFromRoot = abs.slice(root.length + 1);
      const relPath = relFromRoot.slice(0, relFromRoot.length - name.length) + m[1];
      out.push({ relPath: relPath.split("\\").join("/"), stamp: m[2], backupAbs: abs });
    }
  };
  walk(root);
  return out;
}

/** The most recent timestamp present in the backup dir, or null. */
function latestStamp(rootDir: string): string | null {
  const stamps = listBackups(rootDir).map((b) => b.stamp);
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1) ?? null;
}

/** Restore an explicit set of backups (the files one run actually wrote).
 *  Used for failure rollback: restoring "the latest stamp" instead could
 *  resurrect a PREVIOUS run's backups over files the user has since edited,
 *  when the failing run dies before writing its own first backup. */
export function restoreBackups(
  rootDir: string,
  entries: ReadonlyArray<{ relPath: string; backupAbs: string }>,
): string[] {
  const restored: string[] = [];
  for (const entry of entries) {
    if (!existsSync(entry.backupAbs)) continue;
    cp(entry.backupAbs, resolve(rootDir, entry.relPath));
    restored.push(entry.relPath);
  }
  return restored;
}

export interface RestoreResult {
  /** Files put back to what they were before the run. */
  restored: string[];
  /** Files left alone: edited after caretize wrote them (or no longer there). */
  changed: string[];
}

/**
 * Restore the files of the most recent run. A file is put back only while it
 * is byte-for-byte what caretize wrote; anything edited since is left alone
 * and reported, because copying the old bytes over it would delete that work.
 * `force` restores those too (and backups made before hashes were recorded).
 */
export function restoreLatest(rootDir: string, options: { force?: boolean } = {}): RestoreResult {
  const stamp = latestStamp(rootDir);
  const result: RestoreResult = { restored: [], changed: [] };
  if (!stamp) return result;
  for (const entry of listBackups(rootDir)) {
    if (entry.stamp !== stamp) continue;
    const dest = resolve(rootDir, entry.relPath);
    const record = `${entry.backupAbs}.sha256`;
    const untouched = existsSync(dest) && existsSync(record) && readFileSync(record, "utf8").trim() === hashOf(dest);
    if (!untouched && !options.force) { result.changed.push(entry.relPath); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    cp(entry.backupAbs, dest);
    result.restored.push(entry.relPath);
  }
  return result;
}
