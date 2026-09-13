import { describe, expect, it } from "vitest";
import {
  isPublicEntry,
  isPublishedEntry,
  publicationField,
  resolvePreviewPath,
} from "../../packages/core/src/runtime/collection-policy";
import { caret } from "../../packages/core/src/index";
import { loadCollection, loadEntry } from "../../packages/core/src/runtime/content";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { registerCollectionStudioConfig } from "../../packages/core/src/runtime/schema-registry";
import type { UploadHandler } from "../../packages/core/src/types";

describe("collection policy", () => {
  it("treats configured publication as a strict public visibility boundary", () => {
    const config = { publication: { field: "visible" } };
    expect(publicationField(config)).toBe("visible");
    expect(isPublicEntry({ visible: true }, config)).toBe(true);
    expect(isPublicEntry({ visible: false }, config)).toBe(false);
    expect(isPublicEntry({}, config)).toBe(false);
    expect(isPublicEntry({}, {})).toBe(true);
    expect(isPublishedEntry({ published: true })).toBe(true);
    expect(isPublishedEntry({ visible: true }, "visible")).toBe(true);
  });

  it("requires managed publication to have an explicit boolean schema field", () => {
    expect(() => caret({
      collections: { posts: { publication: {} } },
    })).toThrow(/schemas\.posts\.properties\.published must be a boolean field/);

    expect(() => caret({
      schemas: {
        posts: { type: "object", properties: { published: { type: "string" } } },
      },
      collections: { posts: { publication: {} } },
    })).toThrow(/must be a boolean field/);

    expect(() => caret({
      schemas: {
        posts: { type: "object", properties: { visible: { type: "boolean" } } },
      },
      collections: { posts: { publication: { field: "visible" } } },
    })).not.toThrow();
  });

  it("resolves templates and fixed page maps to safe same-origin paths", () => {
    expect(resolvePreviewPath({ previewPath: "/journal/{id}" }, "hello world"))
      .toBe("/journal/hello%20world");
    expect(resolvePreviewPath({ previewPath: { home: "/", about: "/about" } }, "about"))
      .toBe("/about");
    expect(resolvePreviewPath({ previewPath: "https://example.com/{id}" }, "x"))
      .toBeNull();
    expect(resolvePreviewPath({ previewPath: "//example.com/{id}" }, "x"))
      .toBeNull();
  });

  it("applies publication to runtime content reads but not editor previews", async () => {
    const adapter = new InMemoryAdapter();
    adapter.preload("runtime-publication", [
      { id: "draft", data: { title: "Draft", published: false } },
      { id: "live", data: { title: "Live", published: true } },
    ]);
    registerCollectionStudioConfig("runtime-publication", { publication: {} });
    const context = (editor: boolean) => ({
      adapter,
      uploadHandler: {} as UploadHandler,
      sessionId: null,
      demoMode: false,
      editor,
    });

    expect(await runWithRequestContext(context(false), () =>
      loadEntry("runtime-publication", "draft"),
    )).toBeNull();
    expect(await runWithRequestContext(context(false), () =>
      loadCollection("runtime-publication"),
    )).toMatchObject([{ id: "live" }]);
    expect(await runWithRequestContext(context(true), () =>
      loadCollection("runtime-publication"),
    )).toMatchObject([{ id: "draft" }, { id: "live" }]);
  });
});
