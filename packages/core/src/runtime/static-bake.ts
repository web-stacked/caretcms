import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageAdapter } from "../types.js";
import { rewriteCaretAttributes } from "./rewrite.js";
import { scanHtmlTags } from "./html-tokens.js";

const BINDING_PROBE_RE = /\bdata-caret(?:-scope)?\s*=\s*"/;

export interface StaticBakeOptions {
  adapter: StorageAdapter;
  allowedClasses?: Record<string, readonly string[]>;
}

export interface StaticBakeFileResult {
  path: string;
  rewritten: boolean;
}

export interface StaticBakeResult {
  scanned: number;
  rewritten: number;
  files: StaticBakeFileResult[];
}

function pathFromRoot(root: string | URL): string {
  return root instanceof URL ? fileURLToPath(root) : root;
}

async function listHtmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") {
        out.push(path);
      }
    }
  }

  await walk(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** CaretCMS's binding attributes: `data-caret`, `data-caret-rich`, `data-caret-md`, … */
const BINDING_ATTR_RE = /^data-caret(?:-|$)/;
const SPACE_RE = /[\t\n\f\r ]/;

/**
 * Remove CaretCMS's binding attributes from built HTML. A static build has no
 * editor (it runs only in `astro dev`), so visitors' pages don't need them.
 * Only real tags are touched; raw text, comments and attribute values stay as
 * they are (see `scanHtmlTags`).
 */
export function stripBindingAttributes(html: string): string {
  const cuts: Array<[number, number]> = [];
  for (const tag of scanHtmlTags(html)) {
    if (tag.closing) continue;
    for (const [name, attribute] of tag.attributes) {
      if (!BINDING_ATTR_RE.test(name)) continue;
      let start = attribute.start;
      while (start > tag.start && SPACE_RE.test(html[start - 1])) start--;
      cuts.push([start, attribute.end]);
    }
  }
  if (!cuts.length) return html;
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of cuts) {
    out += html.slice(cursor, start);
    cursor = end;
  }
  return out + html.slice(cursor);
}

export async function bakeStaticHtmlString(
  html: string,
  options: StaticBakeOptions,
): Promise<{ html: string; rewritten: boolean }> {
  if (!BINDING_PROBE_RE.test(html)) {
    return { html, rewritten: false };
  }

  const baked = stripBindingAttributes(await rewriteCaretAttributes(html, options.adapter, {
    allowedClasses: options.allowedClasses,
  }));

  return {
    html: baked,
    rewritten: baked !== html,
  };
}

export async function bakeStaticHtmlFiles(
  root: string | URL,
  options: StaticBakeOptions,
): Promise<StaticBakeResult> {
  const rootPath = pathFromRoot(root);
  const files = await listHtmlFiles(rootPath);
  const results: StaticBakeFileResult[] = [];

  for (const path of files) {
    const html = await readFile(path, "utf8");
    const baked = await bakeStaticHtmlString(html, options);
    if (baked.rewritten) {
      await writeFile(path, baked.html, "utf8");
    }
    results.push({ path, rewritten: baked.rewritten });
  }

  return {
    scanned: results.length,
    rewritten: results.filter((result) => result.rewritten).length,
    files: results,
  };
}
