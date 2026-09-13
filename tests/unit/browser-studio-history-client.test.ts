import { describe, expect, it, vi } from "vitest";
import { createStudioHistoryClient } from "../../packages/core/static/cms/studio/history-client.js";

function client(fetchImpl: typeof fetch) {
  return createStudioHistoryClient({ apiBasePath: "/api/cms", fetchImpl });
}

describe("Studio history client", () => {
  it("loads normalized history with an encoded same-origin request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ history: [
      { ts: 12, action: "put", editor: { id: "editor-1", name: "Editor", ignored: true } },
      { ts: 11 },
      { ts: "invalid", action: "put" },
    ] }));
    await expect(client(fetchImpl).list({ collection: "pages & posts", id: "home/path" }))
      .resolves.toEqual({ kind: "loaded", items: [
        { ts: 12, action: "put", editor: { id: "editor-1", name: "Editor" } },
        { ts: 11, action: "save" },
      ] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/cms/history?collection=pages+%26+posts&id=home%2Fpath",
      { credentials: "same-origin" },
    );
  });

  it("restores a snapshot with the editor request header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: { title: "Earlier" }, revision: 5,
    }));
    await expect(client(fetchImpl).restore({ collection: "pages", id: "home", ts: 123 }))
      .resolves.toEqual({ kind: "restored", data: { title: "Earlier" }, revision: 5 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/cms/history", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-caret-request": "1" },
      body: JSON.stringify({ collection: "pages", id: "home", ts: 123 }),
    }));
  });

  it("distinguishes authentication failures for list and restore", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const api = client(fetchImpl);
    await expect(api.list({ collection: "pages", id: "home" })).resolves.toEqual({ kind: "unauthorized" });
    await expect(api.restore({ collection: "pages", id: "home", ts: 1 })).resolves.toEqual({ kind: "unauthorized" });
  });

  it("normalizes HTTP and malformed JSON responses as errors", async () => {
    const api = client(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(Response.json({ revision: 2 })));
    await expect(api.list({ collection: "pages", id: "home" })).resolves.toEqual({ kind: "error" });
    await expect(api.list({ collection: "pages", id: "home" })).resolves.toEqual({ kind: "error" });
    await expect(api.restore({ collection: "pages", id: "home", ts: 1 })).resolves.toEqual({ kind: "error" });
  });
});
