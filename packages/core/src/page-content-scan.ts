import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanHtmlTags } from "./runtime/html-tokens.js";
import { resolveBinding, REWRITABLE_TEXT_TAGS } from "./runtime/rewrite.js";
import { RICH_ALLOWED_TAGS } from "./runtime/rich-allowlist.js";

/** collection → id → field → the text (or image src) the template itself renders. */
export type PageContent = Record<string, Record<string, Record<string, string>>>;

const TEXT_TAGS = new Set<string>(REWRITABLE_TEXT_TAGS);
const SKIP_DIRS = new Set(["node_modules", ".git", ".astro", "dist"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** The template part of an `.astro` file (after its `---` frontmatter fence). */
function templateOf(source: string): string {
  const fence = /^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(source);
  return fence ? source.slice(fence[0].length) : source;
}

/**
 * The text a bound element renders on its own, when the template states it:
 * plain text, or inline formatting the rich allowlist covers. Expressions
 * (`{…}`) and other markup mean the page computes it, so there is nothing to
 * show before an edit.
 */
function staticContent(inner: string): string | null {
  if (inner.includes("{")) return null;
  const tags = [...scanHtmlTags(inner)];
  // Plain inline formatting only: a class or other attribute needs the site's
  // own rules (allowedClasses), so the page computes how it renders.
  const plain = (tag: { name: string; attributes: Map<string, unknown> }) => RICH_ALLOWED_TAGS.has(tag.name) &&
    [...tag.attributes.keys()].every((name) => tag.name === "a" && (name === "href" || name === "title"));
  if (!tags.every(plain)) return null;
  const collapsed = inner.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return tags.length ? collapsed : decodeEntities(collapsed);
}

/** Every literal `data-caret` binding in one template, with its own content. */
export function scanTemplate(source: string, into: PageContent = {}): PageContent {
  const html = templateOf(source);
  type Frame = { name: string; end: number; scope: { collection: string; id: string } | null; binding?: { collection: string; id: string; field: string } };
  const stack: Frame[] = [];
  const nearestScope = () => {
    for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i].scope) return stack[i].scope;
    return null;
  };
  const record = (key: { collection: string; id: string; field: string }, value: string) => {
    const entry = ((into[key.collection] ??= {})[key.id] ??= {});
    // The first occurrence wins; a binding repeated on a page shows one text.
    if (!(key.field in entry)) entry[key.field] = value;
  };
  for (const tag of scanHtmlTags(html)) {
    if (tag.closing) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].name !== tag.name) index--;
      if (index < 0) continue;
      const frame = stack[index];
      stack.splice(index);
      if (frame.binding) {
        const content = staticContent(html.slice(frame.end, tag.start));
        if (content !== null) record(frame.binding, content);
      }
      continue;
    }
    const scopeParts = tag.attributes.get("data-caret-scope")?.value.split("::");
    const scope = scopeParts?.length === 2 ? { collection: scopeParts[0], id: scopeParts[1] } : null;
    const caret = tag.attributes.get("data-caret")?.value;
    const key = caret !== undefined && (tag.name === "img" || TEXT_TAGS.has(tag.name)) ? resolveBinding(caret, scope ?? nearestScope()) : null;
    if (key && tag.name === "img") {
      const src = tag.attributes.get("src")?.value;
      if (src && !src.includes("{")) record(key, src);
    }
    if (!tag.void) stack.push({ name: tag.name, end: tag.end, scope, binding: key && tag.name !== "img" ? key : undefined });
  }
  return into;
}

/** Scan every `.astro` file under `srcDir`. */
export function scanPageContent(srcDir: string): PageContent {
  const content: PageContent = {};
  const walk = (dir: string) => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".astro")) {
        try {
          scanTemplate(readFileSync(join(dir, entry.name), "utf8"), content);
        } catch {
          // An unreadable template contributes nothing.
        }
      }
    }
  };
  walk(srcDir);
  return content;
}
