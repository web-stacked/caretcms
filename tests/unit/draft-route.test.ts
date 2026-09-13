import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../packages/core/src/runtime/routes/draft";
import { issueEditorSessionCookie, getEditorId } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(";")[0];
  return pair.slice(pair.indexOf("=") + 1);
}

describe("draft route GET", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __setRuntimeServicesForTests(null);
  });

  it("reports draft count for the current editor", async () => {
    vi.stubEnv("CARET_SESSION_SECRET", "test-secret");

    const session = cookieValue(issueEditorSessionCookie("/"));
    const cookies = {
      get(name: string) {
        return name === "caret_session" ? { value: session } : undefined;
      },
    };
    const editorId = getEditorId({ cookies });
    expect(editorId).toBeTruthy();

    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Live" });
    const overlay = await base.makeEditorOverlay(editorId!);
    await overlay.writeEntry("pages", "home", { title: "Draft" });
    await overlay.writeEntry("pages", "about", { title: "Also draft" });

    __setRuntimeServicesForTests({
      adapter: base,
      uploadHandler: { async upload() { return { url: "/unused" }; } },
      delivery: { mode: "static", bake: true, publish: { webhookUrl: null, method: "POST", headers: {} } },
    });

    const response = await GET({ cookies } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hasDrafts: true, count: 2, retryRebuild: false });
  });

  it("returns zero when the editor has no drafts", async () => {
    vi.stubEnv("CARET_SESSION_SECRET", "test-secret");

    const session = cookieValue(issueEditorSessionCookie("/"));
    const cookies = {
      get(name: string) {
        return name === "caret_session" ? { value: session } : undefined;
      },
    };

    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: { async upload() { return { url: "/unused" }; } },
      delivery: { mode: "server", bake: false, publish: { webhookUrl: null, method: "POST", headers: {} } },
    });

    const response = await GET({ cookies } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hasDrafts: false, count: 0, retryRebuild: false });
  });
});
