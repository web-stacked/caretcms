/**
 * Backups + restore. Before any file is modified, its current bytes are copied
 * to `.caret/.caretize-bak/<relpath>.<timestamp>.bak`. `--restore` rolls the
 * most recent run back.
 *
 * The timestamp is injected (not read from the clock here) so a single run uses
 * one consistent stamp across all files and the logic stays deterministic/
 * testable.
 */

import {
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync as cp,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const BAK_DIR = join(".caret", ".caretize-bak");

export function backupRoot(rootDir: string): string {
  return resolve(rootDir, BAK_DIR);
}

/** Absolute backup path for a project-relative file at a given timestamp. */
export function backupPathFor(rootDir: string, relPath: string, stamp: string): string {
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
export function latestStamp(rootDir: string): string | null {
  const stamps = listBackups(rootDir).map((b) => b.stamp);
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1) ?? null;
}

/** Restore every file captured under the most recent run. Returns restored paths. */
export function restoreLatest(rootDir: string): string[] {
  const stamp = latestStamp(rootDir);
  if (!stamp) return [];
  const restored: string[] = [];
  for (const entry of listBackups(rootDir)) {
    if (entry.stamp !== stamp) continue;
    const dest = resolve(rootDir, entry.relPath);
    cp(entry.backupAbs, dest);
    restored.push(entry.relPath);
  }
  return restored;
}
