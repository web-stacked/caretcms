/** Conservative HTML element scanner. Never treats raw text or attribute values as tags. */
export type HtmlAttribute = { value: string; start: number; end: number };
export type HtmlTag = {
  name: string;
  start: number;
  end: number;
  closing: boolean;
  void: boolean;
  attributes: Map<string, HtmlAttribute>;
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const SPACE = /[\t\n\f\r ]/;

export function* scanHtmlTags(html: string): Generator<HtmlTag> {
  let cursor = 0;
  let foreignDepth = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) return;
    if (foreignDepth && html.startsWith("<![CDATA[", start)) {
      const end = html.indexOf("]]>", start + 9);
      if (end < 0) return;
      cursor = end + 3;
      continue;
    }
    if (html.startsWith("<!--", start)) {
      const close = /--!?>/g;
      close.lastIndex = start + 4;
      const match = close.exec(html);
      if (!match) return;
      cursor = close.lastIndex;
      continue;
    }
    if (html[start + 1] === "!" || html[start + 1] === "?") {
      const end = html.indexOf(">", start + 2);
      if (end < 0) return;
      cursor = end + 1;
      continue;
    }
    let pos = start + 1;
    const closing = html[pos] === "/";
    if (closing) pos++;
    if (!/[a-zA-Z]/.test(html[pos] ?? "")) { cursor = pos; continue; }
    const nameStart = pos;
    while (pos < html.length && !SPACE.test(html[pos]) && html[pos] !== "/" && html[pos] !== ">") pos++;
    const name = html.slice(nameStart, pos).toLowerCase();
    const attributes = new Map<string, HtmlAttribute>();
    let selfClosing = false;
    while (pos < html.length && html[pos] !== ">") {
      if (SPACE.test(html[pos]) || html[pos] === "/") {
        if (html[pos] === "/" && html[pos + 1] === ">") selfClosing = true;
        pos++; continue;
      }
      const attrStart = pos;
      while (pos < html.length && !SPACE.test(html[pos]) && !"=/ >".includes(html[pos])) pos++;
      const attrName = html.slice(attrStart, pos).toLowerCase();
      if (!attrName) { pos++; continue; }
      while (pos < html.length && SPACE.test(html[pos])) pos++;
      let value = "";
      if (html[pos] === "=") {
        pos++;
        while (pos < html.length && SPACE.test(html[pos])) pos++;
        const quote = html[pos];
        if (quote === '"' || quote === "'") {
          const valueStart = ++pos;
          const end = html.indexOf(quote, pos);
          if (end < 0) return;
          value = html.slice(valueStart, end);
          pos = end + 1;
        } else {
          const valueStart = pos;
          while (pos < html.length && !SPACE.test(html[pos]) && html[pos] !== ">") pos++;
          value = html.slice(valueStart, pos);
        }
      }
      // HTML uses the first occurrence of a duplicate attribute.
      if (!attributes.has(attrName)) attributes.set(attrName, { value, start: attrStart, end: pos });
    }
    if (pos >= html.length) return;
    cursor = pos + 1;
    const foreign = foreignDepth > 0 || name === "svg" || name === "math";
    const tag = { name, start, end: cursor, closing, void: VOID.has(name) || (foreign && selfClosing), attributes };
    if (name === "svg" || name === "math") foreignDepth = Math.max(0, foreignDepth + (closing ? -1 : selfClosing ? 0 : 1));
    yield tag;
    if (closing || tag.void) continue;
    if (name === "plaintext") return;
    if (RAW.has(name)) {
      const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
      close.lastIndex = cursor;
      let match = close.exec(html);
      // Foreign-content scripts can contain CDATA. Closing-tag-looking text
      // inside it is still script source, not an exit from the foreign tree.
      if (foreignDepth) {
        let cdataCursor = cursor;
        while (match) {
          const cdata = html.indexOf("<![CDATA[", cdataCursor);
          if (cdata < 0 || cdata >= match.index) break;
          const end = html.indexOf("]]>", cdata + 9);
          if (end < 0) return;
          cdataCursor = end + 3;
          if (match.index < cdataCursor) { close.lastIndex = cdataCursor; match = close.exec(html); }
        }
      }
      if (!match) return;
      // Script double-escaped states require a full HTML tokenizer. Refuse the
      // ambiguous remainder instead of exposing script source to rewriting.
      if (name === "script" && /<!--[\s\S]*?<script(?=[\t\n\f\r />])/i.test(html.slice(cursor, match.index))) return;
      cursor = match.index;
    }
  }
}

/** Includes Markdown stamps, while excluding attribute-like prose and raw text. */
export function hasCaretBindings(html: string): boolean {
  for (const tag of scanHtmlTags(html)) {
    if (!tag.closing && ["data-caret", "data-caret-scope", "data-caret-md"].some(name => tag.attributes.has(name))) return true;
  }
  return false;
}
