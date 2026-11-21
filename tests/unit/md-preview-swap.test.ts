import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { BODY_OVERLAY_KEY, fnv1a32, formatMdSrc, type MdSrc } from "../../packages/core/src/markdown/contracts";

/** The entry's Markdown body. Drafts and stamps point into it by range and hash. */
const BODY = "## Old title\n\nOriginal paragraph.\n\nSecond\n\n- old item";

/** The source range of `text` in a body. */
function srcOf(text: string, body = BODY): MdSrc {
  const start = body.indexOf(text);
  if (start < 0) throw new Error(`not in body: ${text}`);
  return { start, end: start + text.length, hash: fnv1a32(text) };
}

/** A stamped block as the Markdown plugin renders it. */
function stamp(tag: string, path: string, text: string, body = BODY): string {
  return `<${tag} data-caret-md="blog::hello::body::${path}" data-caret-md-src="${formatMdSrc(srcOf(text, body))}">${text}</${tag}>`;
}

const PAGE = `<article>${stamp("p", "1", "Original paragraph.")}</article>`;
const draft = (text: string, html: string, extra: Record<string, unknown> = {}) => ({ html, md: "x", src: srcOf(text), ...extra });

class BodyAdapter extends InMemoryAdapter {
  body = BODY;
  async readBodySource(): Promise<string | null> { return `---\ntitle: Hello\n---\n\n${this.body}\n`; }
}

async function adapterWith(data: Record<string, unknown>, body = BODY): Promise<BodyAdapter> {
  const adapter = new BodyAdapter();
  adapter.body = body;
  await adapter.writeEntry("blog", "hello", data);
  return adapter;
}

describe("data-caret-md preview swap", () => {
  it("swaps block content with the drafted html", async () => {
    const adapter = await adapterWith({
      title: "Hello",
      [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", "Edited <strong>bold</strong>.") },
    });
    const out = await rewriteCaretAttributes(PAGE, adapter);
    expect(out).toContain(`>Edited <strong>bold</strong>.</p>`);
    expect(out).not.toContain("Original paragraph.");
    // Attributes survive so the editor can re-activate the block.
    expect(out).toContain("data-caret-md=");
  });

  it("tags a swapped block with data-caret-md-draft; unswapped blocks stay unmarked", async () => {
    const drafted = await adapterWith({
      [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", "Edited.") },
    });
    const out = await rewriteCaretAttributes(PAGE, drafted);
    expect(out).toContain("data-caret-md-draft");
    // A block with no draft is never marked (the base/public path stays clean).
    const clean = await rewriteCaretAttributes(PAGE, await adapterWith({ title: "Hello" }));
    expect(clean).not.toContain("data-caret-md-draft");
  });

  it("no draft for that block → untouched", async () => {
    const adapter = await adapterWith({
      [BODY_OVERLAY_KEY]: { "2": draft("Second", "Other block") },
    });
    const out = await rewriteCaretAttributes(PAGE, adapter);
    expect(out).toBe(PAGE);
  });

  it("no __body at all (base adapter = published/bake path) → untouched", async () => {
    const adapter = await adapterWith({ title: "Hello" });
    const out = await rewriteCaretAttributes(PAGE, adapter);
    expect(out).toBe(PAGE);
  });

  it("re-sanitizes drafted html on the way out (defense in depth)", async () => {
    // Even if hostile markup somehow reached the stored draft, the swap must
    // strip it — same trust model as data-caret-rich.
    const adapter = await adapterWith({
      [BODY_OVERLAY_KEY]: {
        "1": draft("Original paragraph.", '<script>alert(1)</script><a href="javascript:alert(1)">x</a>ok'),
      },
    });
    const out = await rewriteCaretAttributes(PAGE, adapter);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("javascript:");
  });

  it("swaps headings and list items too", async () => {
    const html = [
      stamp("h2", "0", "## Old title").replace(">## Old title<", ">Old title<"),
      `<ul>${stamp("li", "3.0", "old item")}</ul>`,
    ].join("");
    const adapter = await adapterWith({
      [BODY_OVERLAY_KEY]: {
        "0": draft("## Old title", "New <em>title</em>"),
        "3.0": draft("old item", "new item"),
      },
    });
    const out = await rewriteCaretAttributes(html, adapter);
    expect(out).toContain(">New <em>title</em></h2>");
    expect(out).toContain(">new item</li>");
  });

  it("malformed bindings and non-record __body shapes never swap or throw", async () => {
    const adapter = await adapterWith({ [BODY_OVERLAY_KEY]: "not-a-record" });
    const cases = [
      `<p data-caret-md="bad">x</p>`,
      `<p data-caret-md="a::b::c::d::e">x</p>`,
      `<p data-caret-md="blog::hello::title::1">x</p>`, // wrong field segment
      PAGE, // valid binding, malformed __body
    ];
    for (const html of cases) {
      await expect(rewriteCaretAttributes(html, adapter)).resolves.toBe(html);
    }
  });

  it("property: swap never escapes the bound element", async () => {
    // Whatever the draft html contains, the swap must stay inside <p>…</p> —
    // markup before/after the bound element is byte-identical.
    const draftArb = fc
      .array(
        fc.constantFrom("<", ">", '"', "&", "a", "1", "</p>", "<p>", "<script>", "x", " "),
        { minLength: 0, maxLength: 12 },
      )
      .map((a) => a.join(""));
    await fc.assert(
      fc.asyncProperty(draftArb, async (draftHtml) => {
        const adapter = await adapterWith({
          [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", draftHtml) },
        });
        const prefix = "<header>BEFORE</header>";
        const suffix = "<footer>AFTER</footer>";
        const out = await rewriteCaretAttributes(prefix + PAGE + suffix, adapter);
        expect(out.startsWith(prefix)).toBe(true);
        expect(out.endsWith(suffix)).toBe(true);
        // The bound element's own tag pair is still intact.
        expect(out).toContain("<p ");
        expect(out.slice(prefix.length)).toContain("</p>");
      }),
      { numRuns: 200 },
    );
  });
});

describe('paragraph group preview', () => {
  it('renders one safe group, removes consumed stamps and preserves neighboring islands', async () => {
    const adapter = await adapterWith({ __body: { '1': {
      html: '', md: 'New', paragraphs: ['New <strong>paragraph</strong>', '<img src=x onerror=alert(1)>Safe'],
      src: { ...srcOf('Original paragraph.\n\nSecond'), hash: fnv1a32('Original paragraph.\n\nSecond') },
      sources: [
        { blockPath: '1', src: srcOf('Original paragraph.'), html: '\"><script>alert(1)</script>' },
        { blockPath: '2', src: srcOf('Second'), html: 'Second' },
      ],
    } } });
    const input = PAGE + stamp('p', '2', 'Second') + '<blockquote>Keep me</blockquote>';
    const output = await rewriteCaretAttributes(input, adapter);
    expect(output).toContain('<p>New <strong>paragraph</strong></p><p>Safe</p></div>');
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('>Second</p>');
    expect(output).toContain('<blockquote>Keep me</blockquote>');
    expect(output.match(/data-caret-md=/g)).toHaveLength(1);
  });
});

describe("a body draft after the source changed", () => {
  // A developer added a paragraph at the top: every block moved down and its path went up by one.
  const MOVED = `New intro from the developer.\n\n${BODY}`;
  const movedPage = `<article>${stamp("p", "0", "New intro from the developer.", MOVED)}${stamp("p", "2", "Original paragraph.", MOVED)}${stamp("p", "3", "Second", MOVED)}</article>`;

  it("follows its block to the new place", async () => {
    const adapter = await adapterWith({ [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", "Edited.") } }, MOVED);
    const out = await rewriteCaretAttributes(movedPage, adapter);
    expect(out).toContain('data-caret-md="blog::hello::body::2"');
    expect(out).toMatch(/body::2"[^>]*data-caret-md-draft>Edited\.<\/p>/);
    expect(out).toContain(">New intro from the developer.</p>");
    expect(out).toContain(">Second</p>");
  });

  it("never shows in the block that took over its old path", async () => {
    // Path 1 is now the heading; the draft belongs to the paragraph.
    const page = `<article>${stamp("h2", "1", "## Old title", MOVED)}${stamp("p", "2", "Original paragraph.", MOVED)}</article>`;
    const adapter = await adapterWith({ [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", "Edited.") } }, MOVED);
    const out = await rewriteCaretAttributes(page, adapter);
    expect(out).toContain(">## Old title</h2>");
    expect(out).toMatch(/body::2"[^>]*data-caret-md-draft>Edited\.<\/p>/);
  });

  it("shows nothing when the block's text was changed", async () => {
    const changed = BODY.replace("Original paragraph.", "Rewritten by the developer.");
    const page = `<article>${stamp("p", "1", "Rewritten by the developer.", changed)}</article>`;
    const adapter = await adapterWith({ [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", "Edited.") } }, changed);
    expect(await rewriteCaretAttributes(page, adapter)).toBe(page);
  });

  it("shows nothing when two identical blocks could be meant", async () => {
    const twice = `Intro.\n\n${BODY}\n\nOriginal paragraph.`;
    const page = `<article><p data-caret-md="blog::hello::body::2" data-caret-md-src="${formatMdSrc(srcOf("Original paragraph.", twice))}">Original paragraph.</p></article>`;
    const adapter = await adapterWith({ [BODY_OVERLAY_KEY]: { "1": draft("Original paragraph.", "Edited.") } }, twice);
    expect(await rewriteCaretAttributes(page, adapter)).toBe(page);
  });

  it("moves a paragraph group and names its sources by their new paths", async () => {
    const group = { html: "", md: "x", paragraphs: ["One", "Two"], src: srcOf("Original paragraph.\n\nSecond"),
      sources: [
        { blockPath: "1", src: srcOf("Original paragraph."), html: "Original paragraph." },
        { blockPath: "2", src: srcOf("Second"), html: "Second" },
      ] };
    const adapter = await adapterWith({ [BODY_OVERLAY_KEY]: { "1": group } }, MOVED);
    const out = await rewriteCaretAttributes(movedPage, adapter);
    expect(out).toContain("<p>One</p><p>Two</p></div>");
    expect(out).not.toContain(">Second</p>");
    const sources = JSON.parse(out.match(/data-caret-md-sources="([^"]+)"/)![1].replaceAll("&quot;", '"'));
    expect(sources.map((source: { blockPath: string; src: string }) => [source.blockPath, source.src])).toEqual([
      ["2", formatMdSrc(srcOf("Original paragraph.", MOVED))], ["3", formatMdSrc(srcOf("Second", MOVED))]]);
  });
});
