import { describe, expect, it } from "vitest";
import { blocksOf, bodyChanges, pageMatches } from "../../packages/core/static/cms/editor/history-body.js";

/** Stand-ins for the page's paragraph elements: only their identity matters. */
function page(body: string) {
  const blocks = blocksOf(body);
  const els = blocks.map((_, index) => ({ name: `p${index}` }) as unknown as HTMLElement);
  return { els, onPage: blocks.map((block, index) => ({ el: els[index], start: block.start, end: block.start + block.text.length, hash: "" })) };
}

const NOW = "First paragraph.\n\nSecond paragraph, edited.\n\nThird paragraph.";

describe("blocksOf", () => {
  it("splits a body at blank lines and keeps where each block starts", () => {
    expect(blocksOf("One.\n\n  \nTwo\nstill two.\n\nThree.")).toEqual([
      { text: "One.", start: 0 },
      { text: "Two\nstill two.", start: 9 },
      { text: "Three.", start: 25 },
    ]);
  });
});

describe("bodyChanges", () => {
  it("shows a paragraph as an earlier version said it", () => {
    const { els, onPage } = page(NOW);
    const changes = bodyChanges(NOW, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", onPage);
    expect([...changes.replace]).toEqual([[els[1], "Second paragraph."]]);
    expect(changes.hide).toEqual([]);
    expect(changes.insert).toEqual([]);
  });

  it("hides a paragraph added since, and shows one removed since where it stood", () => {
    const { els, onPage } = page(NOW);
    const added = bodyChanges(NOW, "First paragraph.\n\nThird paragraph.", onPage);
    expect(added.hide).toEqual([els[1]]);
    const removed = bodyChanges(NOW, "First paragraph.\n\nSecond paragraph, edited.\n\nGone now.\n\nAlso gone.\n\nThird paragraph.", onPage);
    expect(removed.insert).toEqual([
      { after: els[1], before: null, markdown: "Gone now." },
      { after: els[1], before: null, markdown: "Also gone." },
    ]);
  });

  it("shows a removed first paragraph before the next one on the page", () => {
    const { els, onPage } = page(NOW);
    const changes = bodyChanges(NOW, `Opening.\n\n${NOW}`, onPage);
    expect(changes.insert).toEqual([{ after: null, before: els[0], markdown: "Opening." }]);
  });

  it("leaves blocks the page doesn't show as editable alone", () => {
    const body = "Intro.\n\n```js\ncode()\n```\n\nOutro.";
    const all = page(body);
    const onPage = all.onPage.filter((_, index) => index !== 1);
    const changes = bodyChanges(body, "Intro.\n\n```js\nold()\n```\n\nOutro.", onPage);
    expect(changes.replace.size).toBe(0);
  });

  it("leaves a list's items alone: the list is one block of several elements", () => {
    const body = "Intro.\n\n- one\n- two";
    const items = [{ el: { name: "li1" } as unknown as HTMLElement, start: 8, end: 13, hash: "" }, { el: { name: "li2" } as unknown as HTMLElement, start: 14, end: 19, hash: "" }];
    const changes = bodyChanges(body, "Intro.\n\n- one\n- 2", items);
    expect(changes.replace.size).toBe(0);
  });

  it("knows a page rendered from an older body by its block hashes", () => {
    const body = "Hello there.";
    // FNV-1a of "Hello there." as the server stamps it.
    let h = 0x811c9dc5;
    for (const c of body) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
    const hash = (h >>> 0).toString(16).padStart(8, "0");
    const block = { el: {} as HTMLElement, start: 0, end: body.length, hash };
    expect(pageMatches(body, [block])).toBe(true);
    expect(pageMatches("Hello here.", [block])).toBe(false);
  });

  it("changes nothing for the same body", () => {
    const { onPage } = page(NOW);
    const changes = bodyChanges(NOW, NOW, onPage);
    expect(changes.replace.size + changes.hide.length + changes.insert.length).toBe(0);
  });
});
