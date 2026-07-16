import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { spliceBodyBlocks } from "../../packages/core/src/markdown/splice";
import { canonicalBody } from "../../packages/core/src/markdown/canonical-body";
import { fnv1a32 } from "../../packages/core/src/markdown/contracts";

const FILE = `---
title: Hello
tags:
  - a
---

# Heading

First paragraph — em dash included.

Second paragraph here.
`;

let root: string;
let base: MarkdownAdapter;
let overlay: Awaited<ReturnType<MarkdownAdapter["makeEditorOverlay"]>>;
let draft: SessionOverlayAdapter;

const mdPath = () => join(root, "content/blog/hello.md");

async function srcFor(text: string): Promise<string> {
  const { body } = canonicalBody(await readFile(mdPath(), "utf8"));
  const start = body.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  return `${start}:${start + text.length}:${fnv1a32(body.slice(start, start + text.length))}`;
}

async function draftBlock(blockPath: string, srcText: string, html: string): Promise<void> {
  const result = await executeMutation(draft, {
    type: "md_block",
    collection: "blog",
    id: "hello",
    blockPath,
    src: await srcFor(srcText),
    html,
  });
  expect(result.ok).toBe(true);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caret-mdpublish-"));
  await mkdir(join(root, "content/blog"), { recursive: true });
  await writeFile(mdPath(), FILE);
  base = new MarkdownAdapter({
    contentRoot: join(root, "content"),
    metaRoot: join(root, ".caretcms"),
    draftsRoot: join(root, ".caret/drafts"),
  });
  overlay = await base.makeEditorOverlay("editor-1");
  draft = new SessionOverlayAdapter(base, overlay);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publish body splice — full pipeline", () => {
  it("writes the drafted prose into the .md, keeps frontmatter, clears the draft", async () => {
    await draftBlock("1", "First paragraph — em dash included.", "EDITED <strong>prose</strong>.");
    const { published, conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });

    expect(conflicts).toEqual([]);
    expect(published).toHaveLength(1);

    const file = await readFile(mdPath(), "utf8");
    expect(file).toContain("EDITED **prose**.");
    expect(file).not.toContain("First paragraph — em dash included.");
    // Frontmatter intact and NEVER contains the reserved draft key.
    expect(file).toContain("title: Hello");
    expect(file).toContain("- a");
    expect(file).not.toContain("__body");
    // Untouched blocks byte-identical.
    expect(file).toContain("# Heading");
    expect(file).toContain("Second paragraph here.");
    // Overlay cleared; adapter reads reflect the published file.
    expect(await overlay.getEntry("blog", "hello")).toBeNull();
  });

  it("splices multiple blocks in one publish (descending order applied)", async () => {
    await draftBlock("0", "# Heading", "Retitled heading");
    await draftBlock("2", "Second paragraph here.", "New <em>second</em>.");
    const { published, conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });
    expect(conflicts).toEqual([]);
    expect(published).toHaveLength(1);

    const file = await readFile(mdPath(), "utf8");
    expect(file).toContain("# Retitled heading");
    expect(file).toContain("New *second*.");
    expect(file).toContain("First paragraph — em dash included."); // untouched middle block
  });

  it("all-or-nothing: one stale block aborts the whole entry, draft preserved", async () => {
    await draftBlock("1", "First paragraph — em dash included.", "Edited.");
    // Also change frontmatter in the same draft so we can prove it didn't flush.
    const fileBefore = await readFile(mdPath(), "utf8");
    await writeFile(mdPath(), fileBefore.replace("Second paragraph", "Externally changed paragraph"));
    // The draft for block 1 hashed against the ORIGINAL file... but wait: block
    // 1's own range is unchanged. Make it stale by touching ITS text instead.
    await writeFile(mdPath(), fileBefore.replace("First paragraph", "Externally changed"));

    const { published, conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });
    expect(published).toEqual([]);
    expect(conflicts).toEqual([{ collection: "blog", id: "hello", reason: "stale_body" }]);
    // File exactly as the external edit left it; draft still pending.
    expect(await readFile(mdPath(), "utf8")).toBe(
      fileBefore.replace("First paragraph", "Externally changed"),
    );
    expect(await overlay.getEntry("blog", "hello")).not.toBeNull();
  });

  it("body-only publish leaves the frontmatter bytes untouched (no re-quote noise)", async () => {
    // Frontmatter deliberately uses codec-nonpreferred quoting: a body-only
    // publish must not rewrite it (diff noise), only splice the body.
    const quirky = `---\ntitle: "Hello"\ndate: "2026-03-11"\n---\n\nOnly paragraph.\n`;
    await writeFile(mdPath(), quirky);
    await draftBlock("0", "Only paragraph.", "Edited only paragraph.");
    const { conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });
    expect(conflicts).toEqual([]);
    const file = await readFile(mdPath(), "utf8");
    expect(file).toBe(
      `---\ntitle: "Hello"\ndate: "2026-03-11"\n---\n\nEdited only paragraph.\n`,
    );
  });

  it("body draft publish preserves a frontmatter field edited on base after staging", async () => {
    // Reproduces the server-delivery data-loss bug: an inline body edit stages
    // to the per-editor overlay, then a Studio field save writes STRAIGHT to
    // base (frontmatter bypasses the overlay in server mode). Publishing the
    // body draft must splice the prose WITHOUT reverting the newer base field.
    await draftBlock("1", "First paragraph — em dash included.", "Edited body prose.");
    const baseEntry = await base.getEntry("blog", "hello");
    await base.writeEntry("blog", "hello", { ...baseEntry!.data, title: "Studio-edited title" });

    const { published, conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });
    expect(conflicts).toEqual([]);
    expect(published).toHaveLength(1);

    const file = await readFile(mdPath(), "utf8");
    // Body spliced...
    expect(file).toContain("Edited body prose.");
    expect(file).not.toContain("First paragraph — em dash included.");
    // ...AND the Studio field edit survived (not clobbered by a stale snapshot).
    expect(file).toContain("title: Studio-edited title");
    expect(file).not.toContain("title: Hello");
    expect(file).not.toContain("__body");
  });

  it("frontmatter-only draft (no body blocks) publishes exactly as before", async () => {
    await draft.writeEntry("blog", "hello", { title: "New title", tags: ["a"] });
    const { published, conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });
    expect(conflicts).toEqual([]);
    expect(published).toHaveLength(1);
    const file = await readFile(mdPath(), "utf8");
    expect(file).toContain("title: New title");
    expect(file).toContain("First paragraph — em dash included."); // body untouched
  });

  it("corrupt __body map → invalid_body conflict, nothing written", async () => {
    await overlay.writeEntry("blog", "hello", {
      title: "Hello",
      __body: { "1": { md: 42, src: "nope" } },
    });
    const { published, conflicts } = await publishOverlay(base, overlay, {
      collection: "blog",
      id: "hello",
    });
    expect(published).toEqual([]);
    expect(conflicts).toEqual([{ collection: "blog", id: "hello", reason: "invalid_body" }]);
    expect(await readFile(mdPath(), "utf8")).toBe(FILE);
  });

  it("history publish snapshot carries the pre-publish source; restore puts it back", async () => {
    await draftBlock("1", "First paragraph — em dash included.", "Edited body.");
    await publishOverlay(base, overlay, { collection: "blog", id: "hello" });
    expect(await readFile(mdPath(), "utf8")).toContain("Edited body.");

    const history = await base.getHistory("blog", "hello");
    const publishEntry = history.find((h) => h.action === "publish");
    expect(publishEntry?.bodySource).toBe(FILE);

    // Simulate the restore route's bodySource branch.
    await base.writeBodySource("blog", "hello", publishEntry!.bodySource!);
    expect(await readFile(mdPath(), "utf8")).toBe(FILE);
  });
});

describe("spliceBodyBlocks — pure splice unit", () => {
  const src = (text: string, file: string) => {
    const { body } = canonicalBody(file);
    const start = body.indexOf(text);
    return { start, end: start + text.length, hash: fnv1a32(text) };
  };

  it("CRLF file: splice is byte-exact outside the edited range", () => {
    const file = "---\r\ntitle: X\r\n---\r\n\r\nAlpha para.\r\n\r\nBeta para.\r\n";
    const result = spliceBodyBlocks(file, [{ md: "EDITED", src: src("Alpha para.", file) }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("---\r\ntitle: X\r\n---\r\n\r\nEDITED\r\n\r\nBeta para.\r\n");
    }
  });

  it("rejects overlapping ranges", () => {
    const file = "One two three.";
    const result = spliceBodyBlocks(file, [
      { md: "a", src: { start: 0, end: 7, hash: fnv1a32("One two") } },
      { md: "b", src: { start: 4, end: 13, hash: fnv1a32("two three") } },
    ]);
    expect(result).toEqual({ ok: false, reason: "overlap" });
  });

  it("rejects out-of-bounds and wrong-hash ranges as stale", () => {
    const file = "Short.";
    expect(
      spliceBodyBlocks(file, [{ md: "x", src: { start: 0, end: 99, hash: "00000000" } }]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      spliceBodyBlocks(file, [{ md: "x", src: { start: 0, end: 5, hash: "00000000" } }]),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("adjacent (non-overlapping) blocks splice cleanly", () => {
    const file = "AAABBB";
    const result = spliceBodyBlocks(file, [
      { md: "xx", src: { start: 0, end: 3, hash: fnv1a32("AAA") } },
      { md: "yy", src: { start: 3, end: 6, hash: fnv1a32("BBB") } },
    ]);
    expect(result).toEqual({ ok: true, content: "xxyy" });
  });
});
