import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerRebuildWebhook } from "../../packages/core/src/runtime/rebuild-webhook";

const published = [
  { collection: "pages", id: "home", revision: 2, deleted: false },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triggerRebuildWebhook", () => {
  it("does nothing when no webhook URL is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await triggerRebuildWebhook(
      { webhookUrl: null },
      { published, commit: null },
    );

    expect(result).toEqual({ triggered: false, ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts publish details to the configured webhook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    const result = await triggerRebuildWebhook(
      {
        webhookUrl: "https://deploy.example/hook",
        method: "PUT",
        headers: { Authorization: "Bearer token" },
      },
      { published, commit: "abc123" },
    );

    expect(result).toEqual({ triggered: true, ok: true, status: 202 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://deploy.example/hook",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "content-type": "application/json",
          Authorization: "Bearer token",
        }),
      }),
    );

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      source: "caretcms",
      event: "publish",
      commit: "abc123",
      published,
    });
  });

  it("reports a failed webhook response without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );

    const result = await triggerRebuildWebhook(
      { webhookUrl: "https://deploy.example/hook" },
      { published, commit: null },
    );

    expect(result).toEqual({
      triggered: true,
      ok: false,
      status: 500,
      error: "Rebuild webhook failed with status 500",
    });
  });

  it("reports network failures without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const result = await triggerRebuildWebhook(
      { webhookUrl: "https://deploy.example/hook" },
      { published, commit: null },
    );

    expect(result).toEqual({
      triggered: true,
      ok: false,
      error: "Could not reach rebuild webhook",
    });
  });
});

it("aborts a stalled webhook within the configured deadline", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const result = triggerRebuildWebhook({ webhookUrl: "https://deploy.example/hook", timeoutMs: 50 }, { published, commit: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({ triggered: true, ok: false, error: "Rebuild webhook timed out" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
