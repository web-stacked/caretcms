import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaveField } from "../../packages/core/static/cms/editor/save-queue.js";

const entryResponse = (revision: number, data: Record<string, unknown>) =>
  Response.json({ entries: [{ revision, data }] });

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { origin: "https://site.test" },
    dispatchEvent: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inline save queue", () => {
  it("keeps a successful save successful when its JSON body is malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(3, { hero: { headline: "Before" } }))
      .mockResolvedValueOnce(new Response("null", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchImpl);
    const setStatus = vi.fn();
    const save = createSaveField({ setStatus, onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "hero.headline", "After"))
      .resolves.toEqual({ ok: true, revision: 4 });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      type: "save_field",
      collection: "pages",
      id: "home",
      field: "hero.headline",
      value: "After",
      expectedRevision: 3,
    });
    expect(setStatus).toHaveBeenLastCalledWith("idle", "Changes are live");
  });

  it("preserves conflict behavior when the 409 body is malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(1, { sections: [{ title: "Before" }] }))
      .mockResolvedValueOnce(new Response("null", {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(entryResponse(2, { sections: [{ title: "Remote" }] }));
    vi.stubGlobal("fetch", fetchImpl);
    const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "sections.0.title", "Local")).resolves.toEqual({
      ok: false,
      reason: "conflict",
      currentRevision: 2,
      latestValue: "Remote",
    });
  });

  it("rejects malformed successful entry snapshots", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ entries: [{ revision: "3", data: [] }] }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const setStatus = vi.fn();
    const save = createSaveField({ setStatus, onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "hero.headline", "After"))
      .resolves.toEqual({ ok: false, reason: "error" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith("error", "Save failed");
  });
});

it("carries and refreshes the base version alongside the draft revision", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ entries: [{ revision: 0, baseRevision: 3, data: { title: "Old" } }] }))
    .mockResolvedValueOnce(Response.json({ currentRevision: 0, currentBaseRevision: 4 }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ entries: [{ revision: 0, baseRevision: 4, data: { title: "Remote" } }] }))
    .mockResolvedValueOnce(Response.json({ revision: 1 }));
  vi.stubGlobal("fetch", fetchImpl);
  const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });
  expect(await save("pages", "home", "title", "Mine")).toMatchObject({ ok: false, reason: "conflict", latestValue: "Remote" });
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 0, expectedBaseRevision: 3 });
  expect(await save("pages", "home", "title", "Mine")).toMatchObject({ ok: true, revision: 1 });
  expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toMatchObject({ expectedRevision: 0, expectedBaseRevision: 4 });
});

describe("revision checks for inline edits", () => {
  const conflict = () => Response.json({ currentRevision: 5 }, { status: 409 });
  const bodyOf = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call: number) =>
    JSON.parse(String(fetchImpl.mock.calls[call]?.[1]?.body));

  it("checks the first save against the revision primed at page load", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(4, { title: "Rendered" }))
      .mockResolvedValueOnce(Response.json({ revision: 5 }));
    vi.stubGlobal("fetch", fetchImpl);
    const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });

    save.prime("pages", "home");
    await expect(save("pages", "home", "title", "Edited", { baseValue: "Rendered" }))
      .resolves.toEqual({ ok: true, revision: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl, 1)).toMatchObject({ expectedRevision: 4 });
  });

  it("retries quietly when only another field changed", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(4, { title: "Rendered", subtitle: "Old" }))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(entryResponse(5, { title: "Rendered", subtitle: "Changed elsewhere" }))
      .mockResolvedValueOnce(Response.json({ revision: 6 }));
    vi.stubGlobal("fetch", fetchImpl);
    const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "title", "Edited", { baseValue: "Rendered" }))
      .resolves.toEqual({ ok: true, revision: 6 });
    expect(bodyOf(fetchImpl, 3)).toMatchObject({ value: "Edited", expectedRevision: 5 });
  });

  it("treats a field that was never saved as untouched", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ entries: [], revision: 0 }))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(entryResponse(1, { subtitle: "Saved elsewhere" }))
      .mockResolvedValueOnce(Response.json({ revision: 2 }));
    vi.stubGlobal("fetch", fetchImpl);
    const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "title", "Edited", { baseValue: "Template text" }))
      .resolves.toEqual({ ok: true, revision: 2 });
  });

  it("treats the same text saved elsewhere as no conflict", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(4, { title: "Rendered" }))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(entryResponse(5, { title: "Edited" }))
      .mockResolvedValueOnce(Response.json({ revision: 6 }));
    vi.stubGlobal("fetch", fetchImpl);
    const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "title", "Edited", { baseValue: "Rendered" }))
      .resolves.toMatchObject({ ok: true });
  });

  it("asks when someone else changed the same field", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(4, { title: "Rendered" }))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(entryResponse(5, { title: "Theirs" }));
    vi.stubGlobal("fetch", fetchImpl);
    const setStatus = vi.fn();
    const save = createSaveField({ setStatus, onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "title", "Mine", { baseValue: "Rendered" }))
      .resolves.toEqual({ ok: false, reason: "conflict", currentRevision: 5, latestValue: "Theirs" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(setStatus).toHaveBeenLastCalledWith("error", "Revision conflict");
  });

  it("retries at most once", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(entryResponse(4, { title: "Rendered" }))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(entryResponse(5, { title: "Rendered" }))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(entryResponse(6, { title: "Rendered" }));
    vi.stubGlobal("fetch", fetchImpl);
    const save = createSaveField({ setStatus: vi.fn(), onUnauthorized: vi.fn() });

    await expect(save("pages", "home", "title", "Mine", { baseValue: "Rendered" }))
      .resolves.toMatchObject({ ok: false, reason: "conflict" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
