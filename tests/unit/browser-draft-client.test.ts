import { describe, expect, it, vi } from "vitest";
import {
  CmsDraftRequestError,
  createDraftClient,
} from "../../packages/core/static/cms/editor/draft-client.js";

function client(fetchImpl: typeof fetch) {
  return createDraftClient({
    buildUrl: path => `https://site.test/api/cms${path}`,
    fetchImpl,
  });
}

describe("browser draft client", () => {
  it("normalizes draft state and sends the authenticated-editor header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      count: 2.8,
      canPublish: false,
      retryRebuild: true,
    }));
    const result = await client(fetchImpl).getState();
    expect(result).toEqual({ count: 2, canPublish: false, retryRebuild: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://site.test/api/cms/draft",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        headers: expect.objectContaining({ "x-caret-request": "1" }),
      }),
    );
  });

  it("publishes all drafts with an explicit empty JSON body", async () => {
    const payload = { ok: true, published: [], failed: [], conflicts: [] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    expect(await client(fetchImpl).publish()).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://site.test/api/cms/publish",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("discards without sending a request body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await client(fetchImpl).discard();
    const init = fetchImpl.mock.calls[0][1];
    expect(init).toMatchObject({ method: "DELETE" });
    expect(init).not.toHaveProperty("body");
  });

  it("retries only the deployment hook and reports status tracking", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      rebuild: { triggered: true, ok: true },
      deploymentTracked: true,
    }));
    expect(await client(fetchImpl).retryDeployment()).toEqual({ deploymentTracked: true });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ retryRebuild: true });
  });

  it("rejects HTTP and webhook-level retry failures", async () => {
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "denied" }, { status: 403 }),
    )).publish()).rejects.toBeInstanceOf(CmsDraftRequestError);
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      rebuild: { triggered: true, ok: false },
    }))).retryDeployment()).rejects.toBeInstanceOf(CmsDraftRequestError);
  });

  it("uses safe defaults for malformed draft state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      count: "many",
      canPublish: "yes",
      retryRebuild: 1,
    }));
    expect(await client(fetchImpl).getState()).toEqual({
      count: 0,
      canPublish: true,
      retryRebuild: false,
    });
  });
});
