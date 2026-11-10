/**
 * Where an Astro project's content collections load from, read from its
 * content config (`src/content.config.{ts,mts,js,mjs}`, or the legacy
 * `src/content/config.*`).
 *
 * Markdown storage maps `<contentRoot>/<collection>/` and
 * `<contentRoot>/<collection>.json` on its own; a `file()` collection can live
 * anywhere (`file("src/data/menu.json")`). Only the config says where, so this
 * reads it.
 *
 * Why the source and not Astro's generated `.astro/data-store.json`: the data
 * store records a `filePath` per entry, so an empty collection has no path, it
 * does not exist until the first sync (after integrations are set up), and it
 * can be stale. The config is the user's own declaration and is there from the
 * first run.
 *
 * The reader is a small tokenizer, not an evaluator: it finds
 * `defineCollection({ loader: file("…") })` and `glob({ base: "…" })` calls with
 * literal paths, the variable or key each is bound to, and the key each
 * variable gets in `export const collections = { … }`. Anything it cannot read
 * literally is reported as `other`, never guessed.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseDataFile } from "./data-file-codec.js";
import { COLLECTION_NAME_RE } from "./id-contracts.js";

export type ContentConfigCollection =
  | { name: string; loader: "file"; path: string; parser: boolean }
  | { name: string; loader: "glob"; base: string | null }
  | { name: string; loader: "other" };

const CONFIG_FILES = [
  ["src", "content.config.ts"], ["src", "content.config.mts"], ["src", "content.config.js"], ["src", "content.config.mjs"],
  ["src", "content", "config.ts"], ["src", "content", "config.mts"], ["src", "content", "config.js"], ["src", "content", "config.mjs"],
] as const;

/** The project's content config file, or null when it has none. */
export function findContentConfig(projectRoot: string): string | null {
  for (const parts of CONFIG_FILES) {
    const path = join(projectRoot, ...parts);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // not this one
    }
  }
  return null;
}

const cache = new Map<string, { config: string | null; mtimeMs: number; collections: ContentConfigCollection[] | null }>();

/**
 * The collections declared in the project's content config, or null when there
 * is no config or its `collections` export can't be read. Cached per config
 * file modification time, so an edited config is picked up without a restart.
 */
export function readContentConfig(projectRoot: string): ContentConfigCollection[] | null {
  const config = findContentConfig(projectRoot);
  let mtimeMs = -1;
  if (config) {
    try {
      mtimeMs = statSync(config).mtimeMs;
    } catch {
      mtimeMs = -1;
    }
  }
  const cached = cache.get(projectRoot);
  if (cached && cached.config === config && cached.mtimeMs === mtimeMs) return cached.collections;
  let collections: ContentConfigCollection[] | null = null;
  if (config) {
    try {
      collections = parseContentConfig(readFileSync(config, "utf8"), projectRoot);
    } catch {
      collections = null;
    }
  }
  cache.set(projectRoot, { config, mtimeMs, collections });
  return collections;
}

/** `file()` collections whose source is a JSON file: collection name → absolute path. */
export function contentConfigDataFiles(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const collection of readContentConfig(projectRoot) ?? []) {
    if (collection.loader === "file" && extname(collection.path).toLowerCase() === ".json") out.set(collection.name, collection.path);
  }
  return out;
}

/** Source text with comments blanked out (same length, so offsets hold). */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i += 1) out += source[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      const end = stringEnd(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index just past the string literal starting at `start`. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

/** Index of the bracket closing the one at `open`, string-aware; -1 if none. */
function matchingBracket(source: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\"" || ch === "'" || ch === "`") { i = stringEnd(source, i) - 1; continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Top-level comma-separated parts of a bracketed list's inside. */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\"" || ch === "'" || ch === "`") { i = stringEnd(source, i) - 1; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** A plain string literal's value (no template substitutions), or null. */
function literal(text: string): string | null {
  const match = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(text.trim());
  if (!match || (match[1] === "`" && match[2].includes("${"))) return null;
  return match[2].replace(/\\(.)/g, "$1");
}

const IDENT = "[A-Za-z_$][\\w$]*";

/** Local names `astro/loaders` exports are imported under. */
function loaderNames(source: string): { file: Set<string>; glob: Set<string> } {
  const names = { file: new Set<string>(), glob: new Set<string>() };
  const imports = new RegExp(`import\\s*(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']astro/loaders["']`, "g");
  for (const match of source.matchAll(imports)) {
    for (const spec of match[1].split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (!local) continue;
      if (imported === "file") names.file.add(local);
      if (imported === "glob") names.glob.add(local);
    }
  }
  return names;
}

/** What a `defineCollection({...})` argument loads from. */
type LoaderDescription =
  | { loader: "file"; path: string; parser: boolean }
  | { loader: "glob"; base: string | null }
  | { loader: "other" };

function describeLoader(options: string, projectRoot: string, names: { file: Set<string>; glob: Set<string> }): LoaderDescription {
  const loader = new RegExp(`(?:^|[{,\\s])loader\\s*:\\s*(${IDENT})\\s*\\(`).exec(options);
  if (!loader) return { loader: "other" };
  const open = loader.index + loader[0].length - 1;
  const close = matchingBracket(options, open);
  if (close === -1) return { loader: "other" };
  const args = splitTopLevel(options.slice(open + 1, close));
  if (names.file.has(loader[1])) {
    const path = args[0] ? literal(args[0]) : null;
    if (path === null) return { loader: "other" };
    const parser = args.length > 1 && /(?:^|[{,\s])parser\b/.test(args[1]);
    return { loader: "file", path: resolve(projectRoot, path), parser };
  }
  if (names.glob.has(loader[1])) {
    const settings = args[0] ?? "";
    const base = /(?:^|[{,\s])base\s*:\s*((["'`])(?:\\.|(?!\2)[^\\])*\2)/.exec(settings);
    const value = base ? literal(base[1]) : null;
    return { loader: "glob", base: value === null ? null : resolve(projectRoot, value) };
  }
  return { loader: "other" };
}

/**
 * The collections a content config declares, or null when it has no readable
 * `export const collections = { … }`.
 */
export function parseContentConfig(raw: string, projectRoot: string): ContentConfigCollection[] | null {
  const source = stripComments(raw);
  const names = loaderNames(source);
  const byVariable = new Map<string, LoaderDescription>();
  const exported = /export\s+const\s+collections\s*(?::[^=]+)?=\s*\{/.exec(source);
  if (!exported) return null;
  const objectOpen = exported.index + exported[0].length - 1;
  const objectClose = matchingBracket(source, objectOpen);
  if (objectClose === -1) return null;

  const define = /\bdefineCollection\s*\(/g;
  for (const match of source.matchAll(define)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(source, open);
    if (close === -1) continue;
    const description = describeLoader(source.slice(open + 1, close), projectRoot, names);
    const before = source.slice(0, match.index);
    const variable = new RegExp(`(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*$`).exec(before);
    if (variable) byVariable.set(variable[1], description);
  }

  const out: ContentConfigCollection[] = [];
  for (const part of splitTopLevel(source.slice(objectOpen + 1, objectClose))) {
    if (part.startsWith("...")) continue;
    const pair = new RegExp(`^(?:(${IDENT})|(["'])((?:\\\\.|(?!\\2)[^\\\\])*)\\2)\\s*:\\s*([\\s\\S]+)$`).exec(part);
    const name = pair ? (pair[1] ?? pair[3]) : new RegExp(`^${IDENT}$`).test(part) ? part : null;
    if (!name) continue;
    const value = pair ? pair[4].trim() : part;
    let description: LoaderDescription;
    const inline = /^defineCollection\s*\(/.exec(value);
    if (inline) {
      const open = inline[0].length - 1;
      const close = matchingBracket(value, open);
      description = close === -1 ? { loader: "other" } : describeLoader(value.slice(open + 1, close), projectRoot, names);
    } else {
      description = byVariable.get(value) ?? { loader: "other" };
    }
    out.push({ name, ...description });
  }
  return out;
}

/**
 * Collections declared in the content config that Markdown storage can't map
 * to a source it edits, each with the reason, for the dev log.
 */
export function uneditableCollections(projectRoot: string, contentRoot: string): string[] {
  const out: string[] = [];
  const rel = (path: string) => relative(projectRoot, path).split(sep).join("/") || ".";
  for (const collection of readContentConfig(projectRoot) ?? []) {
    const { name } = collection;
    if (!COLLECTION_NAME_RE.test(name)) {
      out.push(`${name} (its name isn't a valid collection id)`);
      continue;
    }
    if (collection.loader === "other") {
      out.push(`${name} (its loader isn't glob() or file() with a literal path)`);
    } else if (collection.loader === "glob") {
      const expected = join(contentRoot, name);
      if (collection.base === null) out.push(`${name} (its glob() base isn't a literal path)`);
      else if (resolve(collection.base) !== resolve(expected)) {
        out.push(`${name} (it loads ${rel(collection.base)}/; Markdown is edited in ${rel(expected)}/)`);
      }
    } else if (extname(collection.path).toLowerCase() !== ".json") {
      out.push(`${name} (${rel(collection.path)} isn't JSON)`);
    } else {
      let source: string | null = null;
      try {
        source = readFileSync(collection.path, "utf8");
      } catch {
        source = null;
      }
      const file = source === null ? null : parseDataFile(source, name);
      if (source === null) out.push(`${name} (${rel(collection.path)} wasn't found)`);
      else if (!file || file.shape === "single") out.push(`${name} (${rel(collection.path)} isn't a list of entries with ids or an object of entries)`);
    }
  }
  return out;
}
