import { describe, expect, it, beforeAll } from "vitest";
import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import { caretSatteriPlugin } from "../../packages/core/src/markdown/satteri";
import { parseMdBinding, parseMdSrc } from "../../packages/core/src/markdown/contracts";

const CONTENT_ROOT = "/project/src/content";
const fileURL = (rel: string) => new URL(`file://${CONTENT_ROOT}/${rel}`);

let render: (body: string, url: URL) => Promise<string>;

beforeAll(async () => {
  const processor = await createSatteriMarkdownProcessor({
    syntaxHighlight: false,
    mdastPlugins: [caretSatteriPlugin({ contentRoot: CONTENT_ROOT })],
  });
  render = async (body, url) => (await processor.render(body, { frontmatter: {}, fileURL: url })).code;
});

/** Extract every stamped element as {tag, binding, src}. */
function stamps(html: string): Array<{ tag: string; binding: string; src: string }> {
  const out: Array<{ tag: string; binding: string; src: string }> = [];
  const re = /<([a-z0-9]+)[^>]*\sdata-caret-md="([^"]*)"[^>]*\sdata-caret-md-src="([^"]*)"/g;
  for (let m; (m = re.exec(html)); ) out.push({ tag: m[1], binding: m[2], src: m[3] });
  return out;
}

describe("caretSatteriPlugin — stamps editable blocks", () => {
  it("stamps headings, paragraphs, list items, and blockquote paragraphs", async () => {
    const body = [
      "# Hello",
      "",
      "Top paragraph.",
      "",
      "- item one",
      "- item two",
      "",
      "> quoted para",
    ].join("\n");
    const html = await render(body, fileURL("blog/hello.md"));
    const s = stamps(html);
    expect(html.match(/data-caret-md-paragraph="true"/g)).toHaveLength(1);

    // Every binding is well-formed and points at blog/hello.
    for (const { binding, src } of s) {
      const b = parseMdBinding(binding);
      expect(b).not.toBeNull();
      expect(b!.collection).toBe("blog");
      expect(b!.id).toBe("hello");
      expect(parseMdSrc(src)).not.toBeNull();
    }
    const paths = s.map((x) => `${x.tag}:${parseMdBinding(x.binding)!.blockPath}`);
    expect(paths).toContain("h1:0"); // heading
    expect(paths).toContain("p:1"); // top paragraph
    expect(paths).toContain("li:2.0"); // first list item (bound on <li>)
    expect(paths).toContain("li:2.1");
    expect(paths).toContain("p:3.0"); // blockquote paragraph
  });

  it("list-item src range excludes the bullet marker", async () => {
    const body = "- item one";
    const html = await render(body, fileURL("blog/hello.md"));
    const [li] = stamps(html);
    const src = parseMdSrc(li.src)!;
    // canonical body is "- item one"; the stamped range is "item one".
    expect(body.slice(src.start, src.end)).toBe("item one");
  });

  it("heading src range includes the # marker", async () => {
    const html = await render("## Title", fileURL("blog/hello.md"));
    const [h] = stamps(html);
    const src = parseMdSrc(h.src)!;
    expect("## Title".slice(src.start, src.end)).toBe("## Title");
  });

  it("does not stamp table cells (island) or code blocks", async () => {
    const body = ["| a | b |", "| - | - |", "| 1 | 2 |", "", "```", "code", "```"].join("\n");
    const html = await render(body, fileURL("blog/hello.md"));
    expect(stamps(html)).toHaveLength(0);
  });

  it("does not stamp a multi-line nested (list) block", async () => {
    // A soft-wrapped list item: its inner paragraph spans two source lines.
    const body = "- line one\n  still the item";
    const html = await render(body, fileURL("blog/hello.md"));
    expect(stamps(html)).toHaveLength(0);
  });

  it("does not stamp setext headings (not editable in v1)", async () => {
    // The write path derives heading context from ATX `#` markers only; a
    // stamped setext heading would be silently demoted to a paragraph on edit.
    const body = "Setext Title\n============\n\nRegular paragraph.";
    const html = await render(body, fileURL("blog/hello.md"));
    const s = stamps(html);
    expect(s.some((x) => x.tag === "h1")).toBe(false);
    expect(s.some((x) => x.tag === "p")).toBe(true);
  });

  it("stamps nothing for a .mdx file", async () => {
    const html = await render("# Hi\n\ntext", fileURL("blog/hello.mdx"));
    expect(stamps(html)).toHaveLength(0);
  });

  it("stamps nothing for a file outside the content root", async () => {
    const html = await render("# Hi\n\ntext", new URL("file:///elsewhere/notes/hi.md"));
    expect(stamps(html)).toHaveLength(0);
  });

  it("stamps nothing for a nested-slug path (v1 flat-only)", async () => {
    const html = await render("# Hi", fileURL("blog/2026/hi.md"));
    expect(stamps(html)).toHaveLength(0);
  });

  it("maps non-ASCII (UTF-8 byte) offsets to string indices", async () => {
    // Sätteri reports UTF-8 byte offsets; em dashes, accents, and emoji must
    // still slice to the exact block text in JS string space.
    const body = ["Café — déjà vu 🚀 test.", "", "1. Étape un — vite", "2. Étape deux"].join(
      "\n",
    );
    const html = await render(body, fileURL("blog/hello.md"));
    for (const { binding, src } of stamps(html)) {
      const { start, end } = parseMdSrc(src)!;
      // Every stamped range slices to clean, in-bounds text (never past the end
      // and never cutting a multi-byte character).
      expect(end).toBeLessThanOrEqual(body.length);
      const slice = body.slice(start, end);
      expect(slice.length).toBe(end - start);
      expect(binding).toContain("::body::");
    }
    // The first paragraph's range is exactly the paragraph text.
    const para = stamps(html).find((s) => s.tag === "p")!;
    const { start, end } = parseMdSrc(para.src)!;
    expect(body.slice(start, end)).toBe("Café — déjà vu 🚀 test.");
  });

  it("CRLF source: stamped ranges still slice to exact block text", async () => {
    // Pins that Sätteri's byte offsets are computed against the source as
    // given (no line-ending normalization) — a CRLF file must still produce
    // ranges that slice cleanly in JS string space.
    const body = "# Title\r\n\r\nFirst para.\r\n\r\nSecond para.\r\n";
    const html = await render(body, fileURL("blog/hello.md"));
    const s = stamps(html);
    expect(s.length).toBeGreaterThanOrEqual(3);
    const canonical = body.trim();
    const texts = s.map(({ src }) => {
      const { start, end } = parseMdSrc(src)!;
      return canonical.slice(start, end);
    });
    expect(texts).toContain("# Title");
    expect(texts).toContain("First para.");
    expect(texts).toContain("Second para.");
  });

  it("normalizes offsets against frontmatter-blanked source", async () => {
    // Simulate a `.md` import: frontmatter blanked to equal-length whitespace,
    // body offsets shifted. Canonical offsets must still index the trimmed body.
    const body = "   \n         \n   \n\n# Heading\n\nBody.";
    const html = await render(body, fileURL("blog/hello.md"));
    const s = stamps(html);
    const heading = s.find((x) => x.tag === "h1")!;
    const src = parseMdSrc(heading.src)!;
    const canonical = body.trim();
    expect(canonical.slice(src.start, src.end)).toBe("# Heading");
  });
});
