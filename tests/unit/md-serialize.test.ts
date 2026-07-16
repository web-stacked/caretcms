import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import {
  serializeBlock,
  SerializeError,
  type SNode,
  type BlockContext,
} from "../../packages/core/src/markdown/serialize";

// --- helpers -------------------------------------------------------------

const t = (value: string): SNode => ({ type: "text", value });
const el = (tag: string, children: SNode[], attrs: Record<string, string> = {}): SNode => ({
  type: "element",
  tag,
  attrs,
  children,
});

// Render markdown with a processor that does NOT apply smart punctuation, so
// round-trips stay byte-faithful (Astro's default turns "-- into en-dashes).
let renderer: Awaited<ReturnType<typeof createSatteriMarkdownProcessor>> | undefined;
async function render(md: string): Promise<string> {
  renderer ??= await createSatteriMarkdownProcessor({
    smartypants: false,
    syntaxHighlight: false,
    features: { smartPunctuation: false },
  });
  const { code } = await renderer.render(md, { frontmatter: {} });
  return code.trim();
}

/** Inner HTML of the single wrapping block element (`<p>…</p>`, `<h2>…</h2>`). */
function inner(html: string): string {
  const m = /^<([a-z0-9]+)[^>]*>([\s\S]*)<\/\1>$/.exec(html.trim());
  if (!m) throw new Error(`unexpected block html: ${html}`);
  return m[2];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * Minimal parser for the closed inline HTML set satteri emits for our marks.
 * DOM-free on purpose — the whole pipeline stays runnable in the Node env.
 */
function parseInlineHtml(html: string): SNode[] {
  const nodes: SNode[] = [];
  let i = 0;
  const stack: { tag: string; attrs: Record<string, string>; children: SNode[] }[] = [];
  const push = (n: SNode) => (stack.length ? stack[stack.length - 1].children.push(n) : nodes.push(n));
  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.startsWith("</", i);
      const gt = html.indexOf(">", i);
      const rawTag = html.slice(i + (close ? 2 : 1), gt).trim();
      if (close) {
        const top = stack.pop()!;
        push(el(top.tag, top.children, top.attrs));
      } else {
        const selfClose = rawTag.endsWith("/");
        const name = rawTag.split(/[\s/]/)[0].toLowerCase();
        const attrs: Record<string, string> = {};
        const hrefM = /href="([^"]*)"/.exec(rawTag);
        if (hrefM) attrs.href = decodeEntities(hrefM[1]);
        if (name === "br" || selfClose) push(el(name, [], attrs));
        else stack.push({ tag: name, attrs, children: [] });
      }
      i = gt + 1;
    } else {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      push(t(decodeEntities(html.slice(i, end))));
      i = end;
    }
  }
  return nodes;
}

const PARA: BlockContext = { block: "paragraph", nested: false };

// --- byte-exact fixtures -------------------------------------------------

describe("serializeBlock — byte-exact output", () => {
  it("plain text paragraph", () => {
    expect(serializeBlock([t("Hello world.")], PARA)).toBe("Hello world.");
  });

  it("bold, italic, inline code, link", () => {
    const nodes = [
      t("A "),
      el("strong", [t("bold")]),
      t(" and "),
      el("em", [t("italic")]),
      t(" and "),
      el("code", [t("x = 1")]),
      t(" and "),
      el("a", [t("link")], { href: "https://example.com" }),
      t("."),
    ];
    expect(serializeBlock(nodes, PARA)).toBe(
      "A **bold** and *italic* and `x = 1` and [link](https://example.com).",
    );
  });

  it("normalizes <b>/<i> to strong/em", () => {
    // Adjacent emphasis alternates delimiters (`**` then `_`) so the runs don't
    // fuse into an ambiguous `***`.
    expect(serializeBlock([el("b", [t("x")]), el("i", [t("y")])], PARA)).toBe("**x**_y_");
  });

  it("alternates delimiters across a run of abutting emphasis", () => {
    const nodes = [el("em", [t("a")]), el("strong", [t("b")]), el("em", [t("c")])];
    expect(serializeBlock(nodes, PARA)).toBe("*a*__b__*c*");
  });

  it("falls back to * when an abutting emphasis is followed by a word char", () => {
    // Underscore can't close against a following word character, so the strong
    // stays on `*` — safe because the preceding em ends in a word char.
    const nodes = [el("em", [t("a")]), el("strong", [t("b")]), t("word")];
    expect(serializeBlock(nodes, PARA)).toBe("*a***b**word");
  });

  it("escapes markdown specials in text", () => {
    expect(serializeBlock([t("a*b_c`d[e]f")], PARA)).toBe("a\\*b\\_c\\`d\\[e\\]f");
    expect(serializeBlock([t("a~b")], PARA)).toBe("a\\~b");
  });

  it("escapes leading block markers in a paragraph", () => {
    expect(serializeBlock([t("# not a heading")], PARA)).toBe("\\# not a heading");
    expect(serializeBlock([t("- not a list")], PARA)).toBe("\\- not a list");
    expect(serializeBlock([t("> not a quote")], PARA)).toBe("\\> not a quote");
  });

  it("emits heading markers from the level", () => {
    expect(serializeBlock([t("Title")], { block: "heading", level: 2 })).toBe("## Title");
  });

  it("fences code spans containing backticks", () => {
    expect(serializeBlock([el("code", [t("a`b")])], PARA)).toBe("``a`b``");
    expect(serializeBlock([el("code", [t("`x`")])], PARA)).toBe("`` `x` ``");
  });

  it("uses angle-bracket destinations for hrefs with spaces", () => {
    expect(serializeBlock([el("a", [t("x")], { href: "/a b" })], PARA)).toBe("[x](</a b>)");
  });

  it("emits a bare email as plain text (GFM auto-links it on render)", () => {
    // Documented behaviour: the serializer does not escape autolink triggers
    // (escaping can't suppress GFM autolink anyway); a plain-text address round-
    // trips into an explicit link on the next edit, never losing the text.
    expect(serializeBlock([t("mail a@b.com")], PARA)).toBe("mail a@b.com");
  });

  it("hard break allowed at top level, refused when nested", () => {
    expect(serializeBlock([t("a"), el("br", []), t("b")], PARA)).toBe("a\\\nb");
    expect(() =>
      serializeBlock([t("a"), el("br", []), t("b")], { block: "paragraph", nested: true }),
    ).toThrow(SerializeError);
  });

  it("escapes setext underlines (ONE-or-more '='/'-') on hard-break lines", () => {
    // `text\n=` re-parses as <h1>text</h1> — setext underlines need only a
    // single marker char, unlike thematic breaks.
    expect(serializeBlock([t("text"), el("br", []), t("=")], PARA)).toBe("text\\\n\\=");
    expect(serializeBlock([t("text"), el("br", []), t("--")], PARA)).toBe("text\\\n\\--");
    expect(serializeBlock([t("text"), el("br", []), t("== =")], PARA)).toBe("text\\\n\\== =");
    expect(serializeBlock([t("=")], PARA)).toBe("\\=");
  });

  it("escapes block markers on EVERY line after a hard break (review finding #1)", () => {
    // CommonMark's block scanner interrupts a paragraph on `# `/`> `/`- ` lines
    // regardless of the preceding inline hard break.
    expect(serializeBlock([t("Line one"), el("br", []), t("# gotcha")], PARA)).toBe(
      "Line one\\\n\\# gotcha",
    );
    expect(serializeBlock([t("a"), el("br", []), t("- item"), el("br", []), t("> q")], PARA)).toBe(
      "a\\\n\\- item\\\n\\> q",
    );
  });

  it("collapses raw newlines/tabs/space-runs in text like HTML rendering does", () => {
    // A raw \n in a text node would otherwise emit a soft break whose next
    // line could open a block; 4+ leading spaces would form indented code.
    expect(serializeBlock([t("a\nb")], PARA)).toBe("a b");
    expect(serializeBlock([t("a\n# not a heading")], PARA)).toBe("a # not a heading");
    expect(serializeBlock([t("    indented?")], PARA)).toBe(" indented?");
    expect(serializeBlock([t("a b")], PARA)).toBe("a b"); // nbsp preserved
  });

  it("hard-fails on control characters in link destinations (review finding #2)", () => {
    expect(() =>
      serializeBlock([el("a", [t("x")], { href: "https://evil.com\n# pwned" })], PARA),
    ).toThrow(SerializeError);
    expect(() => serializeBlock([el("a", [t("x")], { href: "/a\rb" })], PARA)).toThrow(
      SerializeError,
    );
  });
});

describe("serializeBlock — hard failures", () => {
  it("throws on elements outside the closed set", () => {
    expect(() => serializeBlock([el("span", [t("x")])], PARA)).toThrow(SerializeError);
    expect(() => serializeBlock([el("script", [t("x")])], PARA)).toThrow(SerializeError);
    expect(() => serializeBlock([el("u", [t("x")])], PARA)).toThrow(SerializeError);
  });

  it("throws on a link without href", () => {
    expect(() => serializeBlock([el("a", [t("x")])], PARA)).toThrow(SerializeError);
  });

  it("rejects invalid heading levels", () => {
    expect(() => serializeBlock([t("x")], { block: "heading", level: 0 })).toThrow(SerializeError);
    expect(() => serializeBlock([t("x")], { block: "heading", level: 7 })).toThrow(SerializeError);
  });
});

// --- semantic round-trip (idempotence through satteri) -------------------

// A generator for inline content in our closed set. Marks don't nest marks of
// the same kind (matches sanitized editor output) and text avoids trailing/
// leading spaces adjacent to marks (markdown emphasis can't hug whitespace).
// `@`/`:` and `www.` are stripped: GFM auto-links bare emails/URLs on render,
// which is a separate documented behaviour (a plain-text address becomes a
// link on the next edit), not a serializer round-trip property.
const stripAutolink = (s: string): string =>
  s.replace(/[@:]/g, "").replace(/www\./gi, "ww.");
const textArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => stripAutolink(s.replace(/\s+/g, " ")))
  .filter((s) => s.trim().length > 0)
  .map((s) => `x${s}x`);

const leafArb: fc.Arbitrary<SNode> = fc.oneof(
  { weight: 3, arbitrary: textArb.map(t) },
  { weight: 1, arbitrary: textArb.map((s) => el("strong", [t(s)])) },
  { weight: 1, arbitrary: textArb.map((s) => el("em", [t(s)])) },
  { weight: 1, arbitrary: textArb.map((s) => el("code", [t(s)])) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(textArb, fc.constantFrom("https://a.example", "/path", "mailto:a@b.co"))
      .map(([s, href]) => el("a", [t(s)], { href })),
  },
);

const blockArb = fc.array(leafArb, { minLength: 1, maxLength: 6 });

describe("serializeBlock — idempotence through render", () => {
  it("reaches a fixed point after one render round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(blockArb, async (tree) => {
        const md1 = serializeBlock(tree, PARA);
        const html1 = await render(md1);
        const md2 = serializeBlock(parseInlineHtml(inner(html1)), PARA);
        // First serialization canonicalizes; the second is a fixed point.
        const html2 = await render(md2);
        expect(inner(html2)).toBe(inner(html1));
        const md3 = serializeBlock(parseInlineHtml(inner(html2)), PARA);
        expect(md3).toBe(md2);
      }),
      { numRuns: 600 },
    );
  });

  it("adversarial text survives the round-trip", async () => {
    // Markdown collapses insignificant whitespace in paragraphs (leading,
    // trailing, and interior runs), so normalize whitespace the way markdown
    // does before feeding the generator — that collapse is a property of
    // markdown, not a serializer defect.
    const adversarial = fc
      .array(fc.constantFrom(..."*_`[]()#>-+<&\\ ".split(""), "a", "1", "."), {
        minLength: 1,
        maxLength: 20,
      })
      .map((a) => a.join("").replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0);
    await fc.assert(
      fc.asyncProperty(adversarial, async (raw) => {
        const md1 = serializeBlock([t(raw)], PARA);
        const html1 = await render(md1);
        const md2 = serializeBlock(parseInlineHtml(inner(html1)), PARA);
        expect(md2).toBe(md1);
      }),
      { numRuns: 600 },
    );
  });
});
