import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../packages/core/src/runtime/routes/publish";
import { issueEditorSessionCookie, getEditorId } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(";")[0];
  return pair.slice(pair.indexOf("=") + 1);
}

describe("publish route rebuild webhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __setRuntimeServicesForTests(null);
  });

  it("returns rebuild status after publishing a draft", async () => {
    vi.stubEnv("CARET_SESSION_SECRET", "test-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    const session = cookieValue(issueEditorSessionCookie("/"));
    const cookies = {
      get(name: string) {
        return name === "caret_session" ? { value: session } : undefined;
      },
    };
    const editorId = getEditorId({ cookies });
    expect(editorId).toBeTruthy();

    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Published" });
    const overlay = await base.makeEditorOverlay(editorId!);
    await overlay.writeEntry("pages", "home", { title: "Draft" });

    __setRuntimeServicesForTests({
      adapter: base,
      uploadHandler: { async upload() { return { url: "/unused" }; } },
      delivery: {
        mode: "static",
        bake: true,
        publish: {
          webhookUrl: "https://deploy.example/hook",
          method: "POST",
          headers: {},
        },
      },
    });

    const response = await POST({
      cookies,
      request: new Request("https://site.test/api/cms/publish", {
        method: "POST",
        headers: { "x-caret-request": "1" },
        body: "{}",
      }),
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.published).toHaveLength(1);
    expect(body.rebuild).toEqual({ triggered: true, ok: true, status: 202 });
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Draft" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not trigger a rebuild when there are no draft changes", async () => {
    vi.stubEnv("CARET_SESSION_SECRET", "test-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    const session = cookieValue(issueEditorSessionCookie("/"));
    const cookies = {
      get(name: string) {
        return name === "caret_session" ? { value: session } : undefined;
      },
    };

    const base = new InMemoryAdapter();
    __setRuntimeServicesForTests({
      adapter: base,
      uploadHandler: { async upload() { return { url: "/unused" }; } },
      delivery: {
        mode: "static",
        bake: true,
        publish: {
          webhookUrl: "https://deploy.example/hook",
          method: "POST",
          headers: {},
        },
      },
    });

    const response = await POST({
      cookies,
      request: new Request("https://site.test/api/cms/publish", {
        method: "POST",
        headers: { "x-caret-request": "1" },
        body: "{}",
      }),
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      published: [],
      rebuild: { triggered: false, ok: true },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
