import { afterEach, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: { CARET_SESSION_SECRET: "worker-only-session-secret" } }));
vi.mock("cloudflare:workers", () => ({ env }));

import { issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { getRequestContext, runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

afterEach(() => { __setRuntimeServicesForTests(null); vi.unstubAllEnvs(); });

it("verifies Worker-only session secrets before selecting editor drafts and rejects forged preview cookies", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CARET_SESSION_SECRET", "");
  const base = new InMemoryAdapter();
  const uploadHandler = { upload: vi.fn() };
  __setRuntimeServicesForTests({ adapter: base, uploadHandler });
  await base.writeEntry("pages", "home", { title: "Published" });
  const seed = { adapter: base, uploadHandler, sessionId: null, demoMode: false, runtimeEnv: env };
  const token = await runWithRequestContext(seed, async () => issueEditorSessionCookie("/", new Request("https://worker.test"))
    .split(";")[0].slice("caret_session=".length));
  const preview = async (session: string) => onRequest({ locals: {}, request: new Request("https://worker.test"),
    cookies: { get: name => name === "caret_preview" ? { value: "1" } : name === "caret_session" ? { value: session } : undefined } },
  async () => {
    const scope = getRequestContext()!;
    if (scope.overlayActive) await scope.adapter.writeEntry("pages", "home", { title: "Private" });
    return Response.json({ editor: scope.editor, overlay: scope.overlayActive, editorId: Boolean(scope.editorId),
      title: (await scope.adapter.getEntry("pages", "home"))?.data.title });
  });
  expect(await (await preview(token)).json()).toEqual({ editor: true, overlay: true, editorId: true, title: "Private" });
  expect((await base.getEntry("pages", "home"))?.data.title).toBe("Published");
  expect(await (await preview(`${token}forged`)).json()).toEqual({ editor: false, overlay: false, editorId: false, title: "Published" });
  expect(getRequestContext()).toBeUndefined();
});
