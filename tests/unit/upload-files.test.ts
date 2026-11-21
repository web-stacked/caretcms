import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { FilesystemUploadHandler } from "../../packages/core/src/runtime/storage/filesystem-upload-handler";
import { discardOverlay } from "../../packages/core/src/runtime/publish";
import { draftOnlyUploads, publishedUploadFiles, removeDiscardedUploads, uploadUrlsIn } from "../../packages/core/src/runtime/upload-files";

/**
 * An uploaded image is a file in the project. Publishing content that uses it
 * must be able to commit that file too, and discarding the draft that
 * uploaded it must not leave it behind to ship in the next build.
 */

let dir: string;
let handler: FilesystemUploadHandler;
const put = (name: string) => { writeFileSync(join(dir, name), "png"); return `/uploads/${name}`; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-uploads-"));
  mkdirSync(dir, { recursive: true });
  handler = new FilesystemUploadHandler({ uploadsDir: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("uploadUrlsIn", () => {
  it("finds upload URLs in fields, rich text and Markdown", () => {
    expect([...uploadUrlsIn({ cover: "/uploads/a.png", body: '<img src="/uploads/b-1.webp">' }, "![x](/uploads/c.jpg) and /img/d.png", null)].sort())
      .toEqual(["/uploads/a.png", "/uploads/b-1.webp", "/uploads/c.jpg"]);
  });
});

describe("FilesystemUploadHandler.localFile", () => {
  it("maps its own URLs to files and nothing else", () => {
    expect(handler.localFile("/uploads/a.png")).toBe(join(dir, "a.png"));
    for (const url of ["/img/a.png", "/uploads/../secret", "/uploads/a/b.png", "https://example.com/uploads/a.png", "/uploads/"]) {
      expect(handler.localFile(url)).toBeNull();
    }
  });
});

describe("publishedUploadFiles", () => {
  it("lists the image files the published entries use", async () => {
    const base = new InMemoryAdapter();
    await base.writeEntry("services", "care", { image: put("care.png"), gallery: [put("one.png"), "/uploads/missing.png"] });
    await base.writeEntry("services", "other", { image: put("other.png") });
    expect(await publishedUploadFiles(handler, base, [{ collection: "services", id: "care" }]))
      .toEqual([join(dir, "care.png"), join(dir, "one.png")]);
  });

  it("is empty for a handler that stores elsewhere", async () => {
    const base = new InMemoryAdapter();
    await base.writeEntry("services", "care", { image: put("care.png") });
    expect(await publishedUploadFiles({ upload: async () => ({ url: "" }) }, base, [{ collection: "services", id: "care" }])).toEqual([]);
  });
});

describe("discarding a draft that uploaded an image", () => {
  async function setup() {
    const base = new InMemoryAdapter();
    await base.writeEntry("services", "care", { image: put("published.png") });
    await base.writeEntry("services", "other", { image: "/img/static.png" });
    const overlay = await base.makeEditorOverlay("editor-1");
    return { base, overlay, draft: new SessionOverlayAdapter(base, overlay) };
  }

  it("deletes the image only that draft used, and keeps the published one", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("services", "care", { image: put("new.png") });
    const uploads = await draftOnlyUploads(handler, base, overlay, [{ collection: "services", id: "care" }]);
    expect(uploads).toEqual(["/uploads/new.png"]);
    await discardOverlay(overlay);
    expect(await removeDiscardedUploads(handler, overlay, uploads)).toEqual(["/uploads/new.png"]);
    expect(existsSync(join(dir, "new.png"))).toBe(false);
    expect(existsSync(join(dir, "published.png"))).toBe(true);
  });

  it("keeps an image another remaining draft still uses", async () => {
    const { base, overlay, draft } = await setup();
    const shared = put("shared.png");
    await draft.writeEntry("services", "care", { image: shared });
    await draft.writeEntry("services", "other", { image: shared });
    const uploads = await draftOnlyUploads(handler, base, overlay, [{ collection: "services", id: "care" }]);
    await discardOverlay(overlay, { collection: "services", id: "care" });
    expect(await removeDiscardedUploads(handler, overlay, uploads)).toEqual([]);
    expect(existsSync(join(dir, "shared.png"))).toBe(true);
  });

  it("never deletes an image the draft kept from the published entry", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("services", "care", { image: "/uploads/published.png", title: "Edited" });
    expect(await draftOnlyUploads(handler, base, overlay, [{ collection: "services", id: "care" }])).toEqual([]);
  });
});
