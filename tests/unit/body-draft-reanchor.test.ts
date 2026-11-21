import { describe, expect, it } from "vitest";
import { locateBlock, reanchorBodyDrafts, spliceBodyBlocks } from "../../packages/core/src/markdown/splice";
import { BODY_OVERLAY_KEY, fnv1a32, type MdSrc } from "../../packages/core/src/markdown/contracts";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";

/**
 * A body draft points at its block by range and hash. When a developer adds
 * or removes text elsewhere in the file, the block moves but its text is the
 * same: the draft follows it. Only a block whose own text changed, or that
 * can't be told from an identical one, is a conflict.
 */

const BODY = "## What we do\n\nWe come by and do the work.\n\n- Point one\n- Point two";
const srcOf = (text: string, body = BODY): MdSrc => {
  const start = body.indexOf(text);
  return { start, end: start + text.length, hash: fnv1a32(text) };
};

describe("locateBlock", () => {
  it("returns the same range while it still hashes", () => {
    const src = srcOf("Point one");
    expect(locateBlock(BODY, src)).toBe(src);
  });

  it.each([
    ["a paragraph added above", `A new intro.\n\n${BODY}`],
    ["a paragraph removed above", BODY.replace("## What we do\n\n", "")],
    ["a list item added before it", BODY.replace("- Point one", "- Point zero\n- Point one")],
  ])("finds the block after %s", (_name, moved) => {
    for (const text of ["We come by and do the work.", "Point one", "Point two"]) {
      expect(locateBlock(moved, srcOf(text))).toEqual(srcOf(text, moved));
    }
  });

  it("finds a heading with its marker", () => {
    const moved = `Intro.\n\n${BODY}`;
    expect(locateBlock(moved, srcOf("## What we do"))).toEqual(srcOf("## What we do", moved));
  });

  it("returns null when the block's text changed", () => {
    expect(locateBlock(BODY.replace("Point one", "Point 1"), srcOf("Point one"))).toBeNull();
  });

  it("returns null when two identical blocks could be meant", () => {
    expect(locateBlock(`Intro.\n\n${BODY}\n- Point one`, srcOf("Point one"))).toBeNull();
  });

  it("doesn't match the same words inside other text", () => {
    // "Point one" now only appears mid-sentence, not as a block.
    const moved = "Intro.\n\nSee Point one below for details.\n\n- Point 1";
    expect(locateBlock(moved, srcOf("Point one"))).toBeNull();
  });

  it("doesn't match the start of a longer line", () => {
    const moved = "Intro.\n\n- Point one and a half";
    expect(locateBlock(moved, srcOf("Point one"))).toBeNull();
  });
});

describe("spliceBodyBlocks with moved blocks", () => {
  const file = (body: string) => `---\ntitle: Service\n---\n\n${body}\n`;

  it("splices each draft where its block is now", () => {
    const moved = `A new intro.\n\n${BODY}`;
    const result = spliceBodyBlocks(file(moved), [
      { md: "Point one (edited)", src: srcOf("Point one") },
      { md: "We do it well.", src: srcOf("We come by and do the work.") },
    ]);
    expect(result).toEqual({ ok: true, content: file(moved.replace("Point one", "Point one (edited)").replace("We come by and do the work.", "We do it well.")) });
  });

  it("refuses when a block's text changed, and writes nothing", () => {
    const changed = BODY.replace("Point one", "Point 1");
    expect(spliceBodyBlocks(file(changed), [{ md: "x", src: srcOf("Point one") }])).toEqual({ ok: false, reason: "stale" });
  });
});

describe("reanchorBodyDrafts", () => {
  it("shifts a paragraph group and its sources together", () => {
    const group = { md: "x", src: srcOf("- Point one\n- Point two".slice(2)), sources: [
      { blockPath: "2.0", src: srcOf("Point one"), html: "Point one" },
    ] };
    const moved = `Intro.\n\n${BODY}`;
    const { drafts, lost } = reanchorBodyDrafts(moved, { "2.0": group });
    expect(lost).toEqual([]);
    expect((drafts["2.0"] as typeof group).sources[0].src).toEqual(srcOf("Point one", moved));
  });

  it("names the drafts it can't find and leaves them as they were", () => {
    const draft = { md: "Point one (edited)", src: srcOf("Point one") };
    const out = reanchorBodyDrafts(BODY.replace("Point one", "Point 1"), { "2.0": draft });
    expect(out).toEqual({ drafts: { "2.0": draft }, lost: ["2.0"] });
  });
});

class BodyAdapter extends InMemoryAdapter {
  body = BODY;
  async readBodySource(): Promise<string | null> { return `---\ntitle: Service\n---\n\n${this.body}\n`; }
}

describe("body text that changed underneath a draft", () => {
  async function setup() {
    const base = new BodyAdapter();
    await base.writeEntry("services", "care", { title: "Service" });
    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);
    await draft.writeBodyDraft("services", "care", { [BODY_OVERLAY_KEY]: {
      "2.0": { md: "Point one (edited)", html: "Point one (edited)", src: srcOf("Point one") },
      "1": { md: "We do it well.", html: "We do it well.", src: srcOf("We come by and do the work.") },
    } });
    return { base, overlay, draft };
  }

  it("is no conflict while the blocks only moved", async () => {
    const { base, draft } = await setup();
    base.body = `A new intro.\n\n${BODY}`;
    expect(await draft.draftConflict("services", "care")).toBeNull();
  });

  it("reports the editor's text for a block that changed", async () => {
    const { base, draft } = await setup();
    base.body = BODY.replace("Point one", "Point 1");
    expect(await draft.draftConflict("services", "care")).toEqual({ collection: "services", id: "care", removed: false,
      fields: [], body: ["Point one (edited)"] });
  });

  it("drops only the lost text when the editor follows the site", async () => {
    const { base, overlay, draft } = await setup();
    base.body = BODY.replace("Point one", "Point 1");
    expect(await draft.resolveDraftConflict("services", "care", "site")).toBe(true);
    expect(Object.keys((await overlay.getEntry("services", "care"))!.data[BODY_OVERLAY_KEY] as object)).toEqual(["1"]);
    expect(await draft.draftConflict("services", "care")).toBeNull();
  });

  it("drops the draft when the lost text was all of it", async () => {
    const { base, overlay, draft } = await setup();
    base.body = "Everything was rewritten.";
    expect(await draft.resolveDraftConflict("services", "care", "site")).toBe(true);
    expect(await overlay.getEntry("services", "care")).toBeNull();
  });
});
