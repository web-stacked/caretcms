import { describe, expect, it, vi } from "vitest";
import { createStudioEntryLoader } from "../../packages/core/static/cms/studio/entry-loader.js";

function loader(...responses: Response[]) {
  return createStudioEntryLoader({
    apiBasePath: "/api/cms",
    fetchImpl: vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(responses.shift()!)),
  });
}

describe("Studio entry loader", () => {
  it("loads entry, schema, revision, validation, and publication metadata", async () => {
    const api = loader(
      Response.json({ entries: [{ data: { title: "Home" }, revision: 3, validationIssues: [
        { path: "title", message: "Too short" }, { path: 1, message: "ignored" },
      ] }] }),
      Response.json({ schema: { type: "object" }, metadata: { publication: { field: "visible" } } }),
    );
    await expect(api.load({ collection: "pages", id: "home" })).resolves.toEqual({
      kind: "ready", data: { title: "Home" }, revision: 3, schema: { type: "object" },
      validationIssues: [{ path: "title", message: "Too short" }],
      publicationFieldName: "visible", initialized: false,
    });
  });

  it("distinguishes missing entries from initialized new entries", async () => {
    await expect(loader(
      Response.json({ entries: [] }), Response.json({ schema: { type: "object" }, template: { title: "New" } }),
    ).load({ collection: "pages", id: "missing" })).resolves.toMatchObject({ kind: "missing" });
    await expect(loader(
      Response.json({ entries: [] }), Response.json({ schema: { type: "object" }, template: { title: "New" } }),
    ).load({ collection: "pages", id: "new", isNew: true })).resolves.toMatchObject({
      kind: "ready", data: { title: "New" }, revision: 0, initialized: true,
    });
  });

  it("builds a safe template when the schema response omits one", async () => {
    const api = loader(Response.json({ entries: [] }), Response.json({ schema: {
      type: "object", properties: { enabled: { type: "boolean" }, count: { type: "integer", minimum: 2 } },
    } }));
    await expect(api.load({ collection: "pages", id: "new", initializeIfMissing: true }))
      .resolves.toMatchObject({ kind: "ready", data: { enabled: false, count: 2 }, initialized: true });
  });

  it("fails authentication when either parallel request is unauthorized", async () => {
    await expect(loader(new Response(null, { status: 401 }), Response.json({ schema: {} }))
      .load({ collection: "pages", id: "home" })).resolves.toEqual({ kind: "unauthorized" });
    await expect(loader(Response.json({ entries: [] }), new Response(null, { status: 401 }))
      .load({ collection: "pages", id: "home" })).resolves.toEqual({ kind: "unauthorized" });
  });

  it("preserves curated entry read codes and rejects malformed success bodies", async () => {
    await expect(loader(Response.json({ code: "unsupported_frontmatter" }, { status: 422 }), Response.json({}))
      .load({ collection: "gallery", id: "bad" })).resolves.toEqual({ kind: "error", code: "unsupported_frontmatter" });
    await expect(loader(Response.json({ ok: true }), Response.json({}))
      .load({ collection: "pages", id: "home" })).resolves.toEqual({ kind: "error", code: "loadFailed" });
  });
});
