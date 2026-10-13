/**
 * Attribute stega for editor responses.
 *
 * `editable()` and the live loader hide a binding key inside every string, and
 * the browser editor promotes keys it finds in TEXT. A key inside an ATTRIBUTE
 * (an image src, a link href) would instead reach the browser as part of the
 * URL, so the image or link breaks. Before an editor's HTML is sent, this strips
 * stega from every attribute value and turns a keyed `<img src>` into a normal
 * `data-caret` binding, so data-driven images become replaceable too.
 */

import { scanHtmlTags } from "./html-tokens.js";
import { hasStega, stegaClean, stegaDecode } from "./stega.js";
import { payloadKey } from "./stega-policy.js";

const BINDING_KEY = /^[a-z0-9][a-z0-9_-]*::[^:\s]+::[^\s]+$/i;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function promoteAttributeStega(html: string): string {
  if (!hasStega(html)) return html;
  /** Edits applied back to front so earlier offsets stay valid. */
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const tag of scanHtmlTags(html)) {
    if (tag.closing) continue;
    let imageKey: string | undefined;
    for (const [name, attribute] of tag.attributes) {
      const raw = html.slice(attribute.start, attribute.end);
      if (!hasStega(raw)) continue;
      if (tag.name === "img" && name === "src") {
        const key = payloadKey(stegaDecode<unknown>(attribute.value), stegaClean(attribute.value));
        if (key && BINDING_KEY.test(key)) imageKey = key;
      }
      edits.push({ start: attribute.start, end: attribute.end, text: stegaClean(raw) });
    }
    if (imageKey && !tag.attributes.has("data-caret")) {
      // Insert before the tag's closing `>` (or `/>`) and any space before it.
      let insertAt = html.lastIndexOf(">", tag.end - 1);
      if (html[insertAt - 1] === "/") insertAt -= 1;
      while (insertAt > tag.start && /\s/.test(html[insertAt - 1] ?? "")) insertAt -= 1;
      edits.push({ start: insertAt, end: insertAt, text: ` data-caret="${escapeAttribute(imageKey)}"` });
    }
  }
  if (edits.length === 0) return html;
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/**
 * Remove stega from places that are not page content: the document head (the
 * tab title, meta tags, structured data) and script and style text anywhere.
 * Nothing there can be clicked, and in the title it shows as stray symbols.
 */
export function cleanNonContentStega(html: string): string {
  if (!hasStega(html)) return html;
  return html
    .replace(/<head[\s>][\s\S]*?<\/head\s*>/i, (head) => stegaClean(head))
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, (block) => stegaClean(block));
}
