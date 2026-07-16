import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { BODY_OVERLAY_KEY } from "../../packages/core/src/markdown/contracts";

const BINDING = 'data-caret-md="blog::hello::body::1" data-caret-md-src="0:10:00000000"';
const PAGE = `<article><p ${BINDING}>Original paragraph.</p></article>`;

async function adapterWith(data: Record<string, unknown>): Promise<InMemoryAdapter> {
  const adapter = new InMemoryAdapter();
  await adapter.writeEntry("blog", "hello", data);
  return adapter;
}

describe("data-caret-md preview swap", () => {
  it("swaps block content with the drafted html", async () => {
    const adapter = await adapterWith({
      title: "Hello",
      [BODY_OVERLAY_KEY]: { "1": { html: "Edited <strong>bold</strong>.", md: "x" } },
    });
    const out = await rewriteCaretAttributes(PAGE, adapter);
    expect(out).toContain(`>Edited <strong>bold</strong>.</p>`);
    expect(out).not.toContain("Original paragraph.");
    // Attributes survive so the editor can re-activate the block.
    expect(out).toContain("data-caret-md=");
  });

  it("tags a swapped block with data-caret-md-draft; unswapped blocks stay unmarked", async () => {
    const drafted = await adapterWith({
      [BODY_OVERLAY_KEY]: { "1": { html: "Edited.", md: "x" } },
    });
    const out = await rewriteCaretAttributes(PAGE, drafted);
    expect(out).toContain("data-caret-md-draft");
    // A block with no draft is never marked (the base/public path stays clean).
    const clean = await rewriteCaretAttributes(PAGE, await adapterWith({ title: "Hello" }));
    expect(clean).not.toContain("data-caret-md-draft");
  });

  it("no draft for that blockPath → untouched", async () => {
    const adapter = await adapterWith({
      [BODY_OVERLAY_KEY]: { "2": { html: "Other block", md: "x" } },
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
        "1": { html: '<script>alert(1)</script><a href="javascript:alert(1)">x</a>ok', md: "x" },
      },
    });
    const out = await rewriteCaretAttributes(PAGE, adapter);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("javascript:");
  });

  it("swaps headings and list items too", async () => {
    const html = [
      `<h2 data-caret-md="blog::hello::body::0" data-caret-md-src="0:5:00000000">Old title</h2>`,
      `<ul><li data-caret-md="blog::hello::body::2.0" data-caret-md-src="6:9:00000000">old item</li></ul>`,
    ].join("");
    const adapter = await adapterWith({
      [BODY_OVERLAY_KEY]: {
        "0": { html: "New <em>title</em>", md: "x" },
        "2.0": { html: "new item", md: "x" },
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
          [BODY_OVERLAY_KEY]: { "1": { html: draftHtml, md: "x" } },
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
