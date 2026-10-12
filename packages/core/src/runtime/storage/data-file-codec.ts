/**
 * Astro `file()` loader data files: one JSON file holding many entries, as
 * either an array of objects with an `id` or an object keyed by id.
 *
 * Entry data excludes the `id` of the array form (it is the entry's address,
 * not an editable field). Updates replace one entry in place and keep the
 * file's shape, entry order, key order, indentation, and trailing newline.
 */

import { ENTRY_ID_RE } from "./id-contracts.js";

type Data = Record<string, unknown>;

export type DataFile =
  | { shape: "array"; items: Data[]; indent: string | number; newline: boolean }
  | { shape: "object"; entries: Record<string, Data>; indent: string | number; newline: boolean };

function isRecord(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndent(source: string): string | number {
  const match = /^[[{]\r?\n([ \t]+)\S/.exec(source);
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

/** Parses a data file, or returns null when it is not a supported shape. */
export function parseDataFile(source: string): DataFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const indent = detectIndent(source);
  const newline = source.endsWith("\n");
  if (Array.isArray(parsed)) {
    if (!parsed.every((item) => isRecord(item) && typeof item.id === "string")) return null;
    return { shape: "array", items: parsed as Data[], indent, newline };
  }
  if (isRecord(parsed) && Object.values(parsed).every(isRecord)) {
    return { shape: "object", entries: parsed as Record<string, Data>, indent, newline };
  }
  return null;
}

export function dataFileIds(file: DataFile): string[] {
  const ids = file.shape === "array" ? file.items.map((item) => item.id as string) : Object.keys(file.entries);
  return ids.filter((id) => ENTRY_ID_RE.test(id));
}

export function readDataEntry(file: DataFile, id: string): Data | null {
  if (file.shape === "object") return Object.prototype.hasOwnProperty.call(file.entries, id) ? { ...file.entries[id] } : null;
  const item = file.items.find((candidate) => candidate.id === id);
  if (!item) return null;
  const { id: _id, ...data } = item;
  return data;
}

/** `next`'s values in `previous`'s key order (nested objects too), new keys last. */
function inOriginalOrder(previous: unknown, next: unknown): unknown {
  if (!isRecord(previous) || !isRecord(next)) return next;
  const out: Data = {};
  for (const key of Object.keys(previous)) {
    if (Object.prototype.hasOwnProperty.call(next, key)) out[key] = inOriginalOrder(previous[key], next[key]);
  }
  for (const key of Object.keys(next)) if (!(key in out)) out[key] = next[key];
  return out;
}

/** The file contents after setting (or, with `data === null`, removing) one entry. */
export function writeDataEntry(file: DataFile, id: string, data: Data | null): string {
  let value: unknown;
  if (file.shape === "object") {
    const entries: Record<string, Data> = {};
    let replaced = false;
    for (const [key, entry] of Object.entries(file.entries)) {
      if (key !== id) entries[key] = entry;
      else if (data !== null) { entries[key] = inOriginalOrder(entry, data) as Data; replaced = true; }
      else replaced = true;
    }
    if (!replaced && data !== null) entries[id] = data;
    value = entries;
  } else {
    const { id: _ignored, ...fields } = data ?? {};
    const items: Data[] = [];
    let replaced = false;
    for (const item of file.items) {
      if (item.id !== id) { items.push(item); continue; }
      replaced = true;
      if (data !== null) items.push(inOriginalOrder(item, { id, ...fields }) as Data);
    }
    if (!replaced && data !== null) items.push({ id, ...fields });
    value = items;
  }
  return JSON.stringify(value, null, file.indent) + (file.newline ? "\n" : "");
}
