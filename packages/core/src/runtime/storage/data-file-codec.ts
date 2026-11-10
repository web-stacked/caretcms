/**
 * JSON data files under the content root. Three shapes:
 *
 * - `array`: Astro `file()` loader form, objects with a string `id`.
 * - `object`: Astro `file()` loader form, an object of entries keyed by id.
 * - `single`: any other object (a site settings file imported directly). The
 *   whole file is one entry whose id is the file's name.
 *
 * Entry data excludes the `id` of the array form (it is the entry's address,
 * not an editable field). Updates replace one entry in place and keep the
 * file's shape, entry order, and key order, and change only the text of the
 * values that differ (see `json-splice.ts`), so hand formatting survives.
 */

import { ENTRY_ID_RE } from "./id-contracts.js";
import { spliceJson } from "./json-splice.js";

type Data = Record<string, unknown>;

export type DataFile =
  | { shape: "array"; items: Data[]; indent: string | number; source: string }
  | { shape: "object"; entries: Record<string, Data>; indent: string | number; source: string }
  | { shape: "single"; name: string; data: Data; indent: string | number; source: string };

export type DataFileShape = DataFile["shape"];

/** The shape of a parsed data file's value, or null when it is unsupported. */
export function dataFileShape(value: unknown): DataFileShape | null {
  if (Array.isArray(value)) {
    return value.every((item) => isRecord(item) && typeof item.id === "string") ? "array" : null;
  }
  if (!isRecord(value)) return null;
  return Object.values(value).every(isRecord) ? "object" : "single";
}

/**
 * Where a property path inside a data file's value is stored: the entry id and
 * the field path within it. Null for the structure itself (the array, an item,
 * an array item's `id`).
 */
export function dataFileBinding(shape: DataFileShape, name: string, value: unknown, path: readonly string[]): { id: string; field: string } | null {
  if (shape === "single") return path.length ? { id: name, field: path.join(".") } : null;
  if (path.length < 2) return null;
  if (shape === "object") return { id: path[0], field: path.slice(1).join(".") };
  const item = Array.isArray(value) ? value[Number(path[0])] : undefined;
  if (!isRecord(item) || typeof item.id !== "string" || path[1] === "id") return null;
  return { id: item.id, field: path.slice(1).join(".") };
}

function isRecord(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndent(source: string): string | number {
  const match = /^[[{]\r?\n([ \t]+)\S/.exec(source);
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

/** Parses a data file, or returns null when it is not a supported shape. */
export function parseDataFile(source: string, name: string): DataFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const indent = detectIndent(source);
  const shape = dataFileShape(parsed);
  if (shape === "array") return { shape, items: parsed as Data[], indent, source };
  if (shape === "object") return { shape, entries: parsed as Record<string, Data>, indent, source };
  if (shape === "single") return { shape, name, data: parsed as Data, indent, source };
  return null;
}

export function dataFileIds(file: DataFile): string[] {
  if (file.shape === "single") return ENTRY_ID_RE.test(file.name) ? [file.name] : [];
  const ids = file.shape === "array" ? file.items.map((item) => item.id as string) : Object.keys(file.entries);
  return ids.filter((id) => ENTRY_ID_RE.test(id));
}

export function readDataEntry(file: DataFile, id: string): Data | null {
  if (file.shape === "single") return id === file.name ? { ...file.data } : null;
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
  if (file.shape === "single") {
    // The file is the entry: it can be changed but not renamed or removed.
    if (id !== file.name || data === null) throw new Error(`[caretcms] ${file.name}.json holds the single entry "${file.name}"`);
    value = inOriginalOrder(file.data, data);
  } else if (file.shape === "object") {
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
  const before = file.shape === "array" ? file.items : file.shape === "object" ? file.entries : file.data;
  return spliceJson(file.source, before, value, file.indent);
}
