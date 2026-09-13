import { describe, expect, it, vi } from "vitest";
import { createStudioMutationClient } from "../../packages/core/static/cms/studio/mutation-client.js";

function client(fetchImpl: typeof fetch) {
  return createStudioMutationClient({ apiBasePath: "/api/cms", fetchImpl });
}

describe("Studio mutation client", () => {
  it("saves with revision protection and editor request headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ revision: 4 }));
    await expect(client(fetchImpl).save({
      collection: "pages", id: "home", data: { title: "Home" }, expectedRevision: 3,
    })).resolves.toEqual({ kind: "saved", revision: 4 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/cms/mutate", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-caret-request": "1" },
      body: JSON.stringify({ type: "put_entry", collection: "pages", id: "home", data: { title: "Home" }, expectedRevision: 3 }),
    }));
  });

  it("returns curated validation issues", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ issues: [
      { path: "image.width", message: "Must be at least 1" },
      { path: 2, message: "ignored" },
    ] }, { status: 400 }));
    await expect(client(fetchImpl).save({ collection: "pages", id: "home", data: {} }))
      .resolves.toEqual({ kind: "validation", issues: [{ path: "image.width", message: "Must be at least 1" }] });
  });

  it("returns revision conflicts without discarding form data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ currentRevision: 7 }, { status: 409 }));
    await expect(client(fetchImpl).save({ collection: "pages", id: "home", data: {} }))
      .resolves.toEqual({ kind: "conflict", currentRevision: 7 });
  });

  it("distinguishes unauthorized and generic failures", async () => {
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })))
      .save({ collection: "pages", id: "home", data: {} })).resolves.toEqual({ kind: "unauthorized" });
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 500 })))
      .save({ collection: "pages", id: "home", data: {} })).resolves.toEqual({ kind: "error" });
  });

  it("deletes with revision protection and normalizes outcomes", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    const api = client(fetchImpl);
    await expect(api.remove({ collection: "pages", id: "home", expectedRevision: 2 })).resolves.toBe("deleted");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      type: "delete_entry", collection: "pages", id: "home", expectedRevision: 2,
    });
    await expect(api.remove({ collection: "pages", id: "home" })).resolves.toBe("unauthorized");
    await expect(api.remove({ collection: "pages", id: "home" })).resolves.toBe("error");
  });
});
