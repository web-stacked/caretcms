import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";

describe("makeEditorOverlay — InMemory", () => {
  it("isolates draft writes from the base; the same editorId reuses the store", async () => {
    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Published" });

    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);
    await draft.writeEntry("pages", "home", { title: "Draft edit" });

    // overlay sees the draft; base is untouched
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Draft edit" });
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Published" });

    // same editor → same overlay store, so the draft persists across "requests"
    const again = await base.makeEditorOverlay("editor-1");
    expect((await again.getEntry("pages", "home"))?.data).toMatchObject({ title: "Draft edit" });
  });

  it("keeps two editors' drafts separate", async () => {
    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Published" });

    const a = new SessionOverlayAdapter(base, await base.makeEditorOverlay("editor-a"));
    const b = new SessionOverlayAdapter(base, await base.makeEditorOverlay("editor-b"));
    await a.writeEntry("pages", "home", { title: "A's draft" });

    expect((await a.getEntry("pages", "home"))?.data).toEqual({ title: "A's draft" });
    expect((await b.getEntry("pages", "home"))?.data).toEqual({ title: "Published" });
  });
});

describe("makeEditorOverlay — Filesystem", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-draft-fs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("backs drafts under <.caret>/drafts/<editorId>/ without touching the base store", async () => {
    const base = new FilesystemAdapter({
      dataRoot: join(dir, ".caret", "data"),
      metaRoot: join(dir, ".caretcms"),
      draftsRoot: join(dir, ".caret", "drafts"),
    });
    await base.writeEntry("pages", "home", { title: "Published" });

    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);
    await draft.writeEntry("pages", "home", { title: "Draft edit" });

    // draft file landed under the per-editor drafts root; base JSON unchanged
    expect(existsSync(join(dir, ".caret", "drafts", "editor-1", "data", "pages", "home.json"))).toBe(true);
    const baseJson = JSON.parse(readFileSync(join(dir, ".caret", "data", "pages", "home.json"), "utf8"));
    expect(baseJson).toEqual({ title: "Published" });
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Draft edit" });
  });

  it("rejects an unsafe editorId (path traversal guard)", async () => {
    const base = new FilesystemAdapter({ dataRoot: join(dir, "data"), metaRoot: join(dir, "meta") });
    await expect(base.makeEditorOverlay("../escape")).rejects.toThrow(/unsafe editor overlay id/);
  });
});

describe("makeEditorOverlay — Markdown (drafts never touch source .md)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-draft-md-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("edits go to a JSON draft store, leaving the markdown source pristine", async () => {
    const contentRoot = join(dir, "src", "content");
    mkdirSync(join(contentRoot, "blog"), { recursive: true });
    const mdPath = join(contentRoot, "blog", "hello.md");
    const original = "---\ntitle: Published\n---\nBody stays put.\n";
    writeFileSync(mdPath, original);

    const base = new MarkdownAdapter({
      contentRoot,
      metaRoot: join(dir, ".caretcms"),
      draftsRoot: join(dir, ".caret", "drafts"),
    });
    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);

    await draft.writeEntry("blog", "hello", { title: "Draft title" });

    // markdown source byte-for-byte unchanged; draft visible through the overlay
    expect(readFileSync(mdPath, "utf8")).toBe(original);
    expect((await draft.getEntry("blog", "hello"))?.data).toMatchObject({ title: "Draft title" });
    // base read still resolves the published markdown frontmatter
    expect((await base.getEntry("blog", "hello"))?.data).toMatchObject({ title: "Published" });
  });
});
