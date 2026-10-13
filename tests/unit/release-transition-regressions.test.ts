import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY } from "../../packages/core/src/runtime/draft-state";
import { registerCollectionSchema, registerCollectionStudioConfig } from "../../packages/core/src/runtime/schema-registry";
import { createStudioEntryLoader } from "../../packages/core/static/cms/studio/entry-loader.js";
import { POST as restore } from "../../packages/core/src/runtime/routes/history";
import { GET as entries } from "../../packages/core/src/runtime/routes/entries";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";

vi.mock("../../packages/core/src/runtime/config.js", () => ({ getRuntimeConfig: () => ({ mountPath: "/admin", apiBasePath: "/api/cms", editorHome: "/" }) }));
afterEach(() => { vi.restoreAllMocks(); __setRuntimeServicesForTests(null); });

async function fixture(collection = "release-versions") {
  const base = new InMemoryAdapter();
  await base.writeEntry(collection, "one", { title: "Old", note: "Keep" });
  const overlay = await base.makeEditorOverlay("alice");
  return { base, overlay, draft: new SessionOverlayAdapter(base, overlay), collection };
}
async function changeBase(base: InMemoryAdapter, collection: string) {
  expect((await executeMutation(base, { type: "save_field", collection, id: "one", field: "title", value: "Other editor" })).ok).toBe(true);
}
function put(collection: string, data: Record<string, unknown>, revision = 0, baseRevision?: number) {
  return { type: "put_entry", collection, id: "one", data, expectedRevision: revision,
    ...(baseRevision !== undefined ? { expectedBaseRevision: baseRevision } : {}) };
}
async function route(base: InMemoryAdapter, handler: (ctx: any) => Promise<Response>, path: string, body?: unknown, preview = false) {
  __setRuntimeServicesForTests({ adapter: base, uploadHandler: { upload: vi.fn() } });
  const token = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
  const url = new URL(path, "http://localhost");
  const request = new Request(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-caret-request": "1" }, body: JSON.stringify(body) });
  const context = { request, url, locals: {}, cookies: { get(name: string) { return name === "caret_session" ? { value: token } : preview && name === "caret_preview" ? { value: "1" } : undefined; } } };
  return onRequest(context, () => handler(context));
}

describe("first structured draft versions", () => {
  it("returns independent base and draft versions for fallback and merged views", async () => {
    const { base, overlay, draft, collection } = await fixture();
    await changeBase(base, collection);
    expect(await draft.getEntrySnapshot(collection, "one")).toMatchObject({ revision: 0, baseRevision: 1, entry: { data: { title: "Other editor" } } });
    await overlay.writeEntry(collection, "one", { __body: {}, [DRAFT_STATE_KEY]: { version: 1, baseRevision: 0, baseData: { title: "Old", note: "Keep" }, structured: false } });
    expect(await draft.getEntrySnapshot(collection, "one")).toMatchObject({ revision: 0, baseRevision: 1 });
    const response = await route(base, entries, `/api/cms/entries?collection=${collection}&id=one`, undefined, true);
    expect(await response.json()).toMatchObject({ revision: 0, baseRevision: 1, entries: [{ revision: 0, baseRevision: 1 }] });
  });

  it("rejects a stale first whole-entry save without creating a draft or history", async () => {
    const { base, overlay, draft, collection } = await fixture();
    const read = await draft.getEntrySnapshot(collection, "one");
    await changeBase(base, collection);
    expect(await executeMutation(draft, put(collection, { ...read.entry!.data, note: "Mine" }, read.revision, read.baseRevision))).toMatchObject({ ok: false, status: 409, body: { currentRevision: 0, currentBaseRevision: 1 } });
    expect(await overlay.getEntry(collection, "one")).toBeNull();
    expect(await overlay.getRevision(collection, "one")).toBe(0);
    expect(await overlay.getHistory(collection, "one")).toEqual([]);
    expect((await base.getEntry(collection, "one"))?.data.title).toBe("Other editor");
  });

  it("rejects an incomplete conditional replacement and accepts an explicit refresh", async () => {
    const { base, draft, collection } = await fixture();
    expect(await executeMutation(draft, put(collection, { title: "Mine" }))).toMatchObject({ ok: false, status: 409, body: { currentBaseRevision: 0 } });
    await changeBase(base, collection);
    const refreshed = await draft.getEntrySnapshot(collection, "one");
    expect((await executeMutation(draft, put(collection, { ...refreshed.entry!.data, note: "Mine" }, refreshed.revision, refreshed.baseRevision))).ok).toBe(true);
  });

  it("refreshes a body-only baseline when the first structured edit observes newer base fields", async () => {
    const { base, overlay, draft, collection } = await fixture();
    await draft.writeBodyDraft(collection, "one", { __body: {} });
    await changeBase(base, collection);
    const read = await draft.getEntrySnapshot(collection, "one");
    expect((await executeMutation(draft, put(collection, { title: "Other editor", note: "Mine" }, read.revision, read.baseRevision))).ok).toBe(true);
    expect((await overlay.getEntry(collection, "one"))?.data[DRAFT_STATE_KEY]).toMatchObject({ baseRevision: 1, baseData: { title: "Other editor", note: "Keep" }, structured: true });
    expect((await publishOverlay(base, overlay)).published).toHaveLength(1);
    expect((await base.getEntry(collection, "one"))?.data).toEqual({ title: "Other editor", note: "Mine" });
  });

  it("keeps an existing structured baseline so later base changes conflict at publish", async () => {
    const { base, overlay, draft, collection } = await fixture();
    expect((await executeMutation(draft, put(collection, { title: "Mine" }, 0, 0))).ok).toBe(true);
    await changeBase(base, collection);
    expect((await executeMutation(draft, put(collection, { title: "Mine again" }, 1, 0))).ok).toBe(true);
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([{ collection, id: "one", reason: "stale_entry" }]);
  });

  it.each([-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1])("rejects malformed base version %s", async value => {
    const { draft, collection } = await fixture();
    expect(await executeMutation(draft, { ...put(collection, {}), expectedBaseRevision: value })).toMatchObject({ ok: false, status: 400 });
  });

  it("Studio retains both versions for stored and missing entries", async () => {
    for (const entries of [[{ data: { title: "Old" }, revision: 2, baseRevision: 7 }], []]) {
      const loader = createStudioEntryLoader({ apiBasePath: "/api/cms", fetchImpl: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ entries, revision: 2, baseRevision: 7 }))
        .mockResolvedValueOnce(Response.json({ schema: { type: "object" }, template: {} })) });
      expect(await loader.load({ collection: "pages", id: "one", isNew: true })).toMatchObject({ kind: "ready", revision: 2, baseRevision: 7 });
    }
  });
});

describe("publication transition validation", () => {
  it("preserves a draft after the schema changes without starting a recovery plan", async () => {
    const { base, overlay, draft, collection } = await fixture("release-publish-schema");
    await draft.writeEntry(collection, "one", { title: "Mine" });
    registerCollectionSchema(collection, { type: "object", required: ["note"], properties: { note: { type: "string" } } }, null);
    const before = await base.getEntry(collection, "one");
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([{ collection, id: "one", reason: "invalid_entry" }]);
    expect(await base.getEntry(collection, "one")).toEqual(before);
    expect(await base.getRevision(collection, "one")).toBe(0);
    expect(await base.getHistory(collection, "one")).toEqual([]);
    expect((await overlay.getEntry(collection, "one"))?.data[PUBLISH_RECOVERY_KEY]).toBeUndefined();
  });

  it("validates managed publication even without an explicit schema", async () => {
    const { base, overlay, draft, collection } = await fixture("release-publish-flag");
    await draft.writeEntry(collection, "one", { title: "Mine", published: "yes" });
    registerCollectionStudioConfig(collection, { publication: { field: "published" } });
    expect((await publishOverlay(base, overlay)).conflicts[0].reason).toBe("invalid_entry");
  });

  it.each([false, true])("revalidates a persisted plan only before data is applied (already applied: %s)", async applied => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { base, overlay, draft, collection } = await fixture(`release-plan-${applied}`);
    await draft.writeEntry(collection, "one", { title: "Mine" });
    const method = applied ? "deleteEntry" : "writeEntry";
    const spy = vi.spyOn(applied ? overlay : base, method).mockRejectedValueOnce(new Error("outage"));
    expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
    spy.mockRestore();
    registerCollectionSchema(collection, { type: "object", required: ["newField"] }, null);
    const result = await publishOverlay(base, overlay);
    if (applied) {
      expect(result.published).toHaveLength(1);
      expect(await overlay.getEntry(collection, "one")).toBeNull();
      expect(await base.getRevision(collection, "one")).toBe(1);
      expect(await base.getHistory(collection, "one")).toHaveLength(1);
    } else {
      expect(result.conflicts[0].reason).toBe("invalid_entry");
      expect((await base.getEntry(collection, "one"))?.data.title).toBe("Old");
      expect((await overlay.getEntry(collection, "one"))?.data[PUBLISH_RECOVERY_KEY]).toBeDefined();
    }
  });

  it("rejects restore snapshots invalid under the current schema without side effects", async () => {
    const { base, collection } = await fixture("release-restore-schema");
    await base.appendHistory(collection, "one", { ts: 123, action: "put", data: { title: "Incomplete" } });
    registerCollectionSchema(collection, { type: "object", required: ["note"] }, null);
    const before = await base.getEntry(collection, "one");
    const response = await route(base, restore, "/api/cms/history", { collection, id: "one", ts: 123 });
    expect(response.status).toBe(400);
    expect((await response.json()).issues).toHaveLength(1);
    expect(await base.getEntry(collection, "one")).toEqual(before);
    expect(await base.getRevision(collection, "one")).toBe(0);
    expect(await base.getHistory(collection, "one")).toHaveLength(1);
  });
});

it("rejects source-backed restore data that differs from the snapshot fields", async () => {
  const { base, collection } = await fixture("release-restore-source");
  const writeSource = vi.fn();
  Object.assign(base, { writeBodySource: writeSource, readBodySource: async () => "---\ntitle: Old\nnote: Keep\n---\nBody" });
  await base.appendHistory(collection, "one", { ts: 321, action: "publish", data: { title: "Valid" }, bodySource: "---\ntitle: Different\n---\nBody" });
  const response = await route(base, restore, "/api/cms/history", { collection, id: "one", ts: 321 });
  expect(response.status).toBe(400);
  expect((await response.json()).issues[0].code).toBe("invalid_source");
  expect(writeSource).not.toHaveBeenCalled();
  expect(await base.getRevision(collection, "one")).toBe(0);
  expect(await base.getHistory(collection, "one")).toHaveLength(1);
});

it("finishes revision and history recovery after content was persisted under an older schema", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { base, overlay, draft, collection } = await fixture("release-plan-after-write");
  await draft.writeEntry(collection, "one", { title: "Mine" });
  const write = base.writeEntry.bind(base);
  vi.spyOn(base, "writeEntry").mockImplementationOnce(async (...args) => {
    await write(...args);
    throw new Error("lost acknowledgement");
  });
  expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
  expect(await base.getRevision(collection, "one")).toBe(0);
  expect((await base.getEntry(collection, "one"))?.data.title).toBe("Mine");
  registerCollectionSchema(collection, { type: "object", required: ["newField"] }, null);
  expect((await publishOverlay(base, overlay)).published).toHaveLength(1);
  expect(await base.getRevision(collection, "one")).toBe(1);
  expect(await base.getHistory(collection, "one")).toHaveLength(1);
  expect(await overlay.getEntry(collection, "one")).toBeNull();
});

it("validates content fields without treating retained Markdown plumbing as a schema field", async () => {
  const { base, overlay, draft, collection } = await fixture("release-mixed-schema");
  registerCollectionSchema(collection, { type: "object", additionalProperties: false, properties: { title: { type: "string" }, note: { type: "string" } } }, null);
  await draft.writeBodyDraft(collection, "one", { __body: {} });
  expect((await executeMutation(draft, { type: "save_field", collection, id: "one", field: "title", value: "Mine", expectedRevision: 0, expectedBaseRevision: 0 })).ok).toBe(true);
  expect((await overlay.getEntry(collection, "one"))?.data.__body).toEqual({});
  expect((await publishOverlay(base, overlay)).published).toHaveLength(1);
  expect((await base.getEntry(collection, "one"))?.data).toEqual({ title: "Mine", note: "Keep" });
});

it("preserves a body-only draft when a stale structured replacement is rejected", async () => {
  const { base, overlay, draft, collection } = await fixture("release-body-stale-token");
  await draft.writeBodyDraft(collection, "one", { __body: {} });
  const before = await overlay.getEntry(collection, "one");
  const observed = await draft.getEntrySnapshot(collection, "one");
  await changeBase(base, collection);
  expect(await executeMutation(draft, put(collection, { title: "Old", note: "Mine" }, observed.revision, observed.baseRevision))).toMatchObject({ ok: false, status: 409 });
  expect(await overlay.getEntry(collection, "one")).toEqual(before);
  expect(await overlay.getHistory(collection, "one")).toEqual([]);
});

it("preflights every base version before a draft reorder writes any member", async () => {
  const { base, overlay, draft, collection } = await fixture("release-reorder-token");
  await base.writeEntry(collection, "two", { title: "Second" });
  expect((await executeMutation(base, { type: "save_field", collection, id: "two", field: "title", value: "Remote" })).ok).toBe(true);
  const result = await executeMutation(draft, { type: "reorder_entries", collection, items: [
    { id: "one", order: 2, expectedRevision: 0, expectedBaseRevision: 0 },
    { id: "two", order: 1, expectedRevision: 0, expectedBaseRevision: 0 },
  ] });
  expect(result).toMatchObject({ ok: false, status: 409, body: { conflictId: "two", currentBaseRevision: 1 } });
  for (const id of ["one", "two"]) {
    expect(await overlay.getEntry(collection, id)).toBeNull();
    expect(await overlay.getRevision(collection, id)).toBe(0);
    expect(await overlay.getHistory(collection, id)).toEqual([]);
  }
});
