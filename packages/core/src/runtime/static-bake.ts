import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageAdapter } from "../types.js";
import { rewriteCaretAttributes } from "./rewrite.js";

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

export async function bakeStaticHtmlString(
  html: string,
  options: StaticBakeOptions,
): Promise<{ html: string; rewritten: boolean }> {
  if (!BINDING_PROBE_RE.test(html)) {
    return { html, rewritten: false };
  }

  const baked = await rewriteCaretAttributes(html, options.adapter, {
    allowedClasses: options.allowedClasses,
  });

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
