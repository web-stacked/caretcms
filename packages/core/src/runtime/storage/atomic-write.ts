import { rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Crash-safe filesystem write primitives shared by every filesystem-backed
 * StorageAdapter and the sidecar metadata store.
 */

/**
 * Write a file atomically: stream into a sibling temp file, then rename over
 * the target. rename(2) is atomic on the same filesystem, so a crash/SIGKILL
 * mid-write can never leave a truncated or empty file — readers always see
 * either the old contents or the complete new contents. The temp file is a
 * sibling (same dir → same filesystem) so the rename stays atomic and never
 * crosses a device boundary.
 */
export async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, contents, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

const writeChains = new Map<string, Promise<unknown>>();

/**
 * Serialize async tasks that share a `key` so their read-modify-write sequences
 * never interleave. Used for the single shared revisions store, where a torn
 * read-increment-write would lose revision state and defeat optimistic
 * concurrency. Keyed by an arbitrary string (typically a file path); chains are
 * cleaned up once drained so the map can't grow unbounded.
 */
export function serializeWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    key,
    next.finally(() => {
      if (writeChains.get(key) === next) {
        writeChains.delete(key);
      }
    }),
  );
  return next;
}
