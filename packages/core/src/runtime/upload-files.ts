import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { StorageAdapter, UploadHandler } from "../types.js";

/** An upload URL wherever it appears in stored content: a field value, rich text, Markdown. */
const UPLOAD_URL_RE = /\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*/g;

/** Upload URLs used anywhere in these values (entry data, Markdown source). */
export function uploadUrlsIn(...values: unknown[]): Set<string> {
  const urls = new Set<string>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const match of text.match(UPLOAD_URL_RE) ?? []) urls.add(match);
  }
  return urls;
}

/** Upload URLs an entry uses, in its data and in its Markdown source. */
async function entryUploadUrls(adapter: StorageAdapter, collection: string, id: string): Promise<Set<string>> {
  const [entry, source] = await Promise.all([
    adapter.getEntry(collection, id).catch(() => null),
    adapter.readBodySource ? adapter.readBodySource(collection, id).catch(() => null) : null,
  ]);
  return uploadUrlsIn(entry?.data, source);
}

/**
 * The image files on this machine that these published entries use. A publish
 * that commits content commits them too: without the file, a site deployed
 * from Git shows a broken image.
 */
export async function publishedUploadFiles(
  handler: UploadHandler, base: StorageAdapter, entries: ReadonlyArray<{ collection: string; id: string; deleted?: boolean }>,
): Promise<string[]> {
  if (!handler.localFile) return [];
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    for (const url of await entryUploadUrls(base, entry.collection, entry.id)) {
      const file = handler.localFile(url);
      if (file && existsSync(file)) files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * Uploads that only these drafts use: in the draft, but not in the published
 * version of the same entry. Collected before a discard, deleted after it.
 */
export async function draftOnlyUploads(
  handler: UploadHandler, base: StorageAdapter, overlay: StorageAdapter, entries: ReadonlyArray<{ collection: string; id: string }>,
): Promise<string[]> {
  if (!handler.localFile) return [];
  const urls = new Set<string>();
  for (const { collection, id } of entries) {
    const published = await entryUploadUrls(base, collection, id);
    const draft = await overlay.getEntry(collection, id).catch(() => null);
    for (const url of uploadUrlsIn(draft?.data)) if (!published.has(url)) urls.add(url);
  }
  return [...urls];
}

/**
 * Delete discarded uploads from disk, so an image the editor decided not to
 * publish doesn't ship in the next build. An upload another remaining draft
 * of this editor still uses is kept. Returns the URLs removed.
 */
export async function removeDiscardedUploads(handler: UploadHandler, overlay: StorageAdapter, urls: readonly string[]): Promise<string[]> {
  if (!handler.localFile || !urls.length) return [];
  const stillUsed = new Set<string>();
  for (const collection of await overlay.discoverCollections()) {
    for (const entry of await overlay.listEntries(collection)) for (const url of uploadUrlsIn(entry.data)) stillUsed.add(url);
  }
  const removed: string[] = [];
  for (const url of urls) {
    const file = handler.localFile(url);
    if (!file || stillUsed.has(url)) continue;
    try { await unlink(file); removed.push(url); } catch { /* already gone */ }
  }
  return removed;
}
