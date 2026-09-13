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
    expect(setStatus).toHaveBeenLastCalledWith("idle", "Saved");
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
