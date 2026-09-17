import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDevAuthContext, withDevRequest } from "../../packages/core/src/runtime/dev-request-context";
import { getEditorId, issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

const pageRequest = () => new Request("http://localhost/articles/home");
const context = () => ({
  request: pageRequest(),
  isPrerendered: true,
  locals: {} as Record<string, unknown>,
  cookies: { get: () => undefined },
});
const next = async () => new Response('<h1 data-caret="pages::home::headline">Template</h1>', {
  headers: { "content-type": "text/html" },
});

describe("static dev request identity", () => {
  let adapter: InMemoryAdapter;

  beforeEach(async () => {
    vi.stubGlobal("__ASTRO_CARET_DEV__", true);
    vi.stubEnv("CARET_SESSION_SECRET", "unit-test-only-static-preview-secret");
    adapter = new InMemoryAdapter();
    await adapter.writeEntry("pages", "home", { headline: "Published" });
    __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() } });
  });

  afterEach(() => {
    __setRuntimeServicesForTests(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function editorDraft(headline: string) {
    const cookie = issueEditorSessionCookie().split(";")[0];
    const auth = withDevRequest({ headers: { cookie } }, () => getDevAuthContext(pageRequest(), true)!);
    const overlay = await adapter.makeEditorOverlay(getEditorId(auth)!);
    await overlay.writeEntry("pages", "home", { headline });
    return cookie;
  }

  it("keeps overlapping editors and anonymous requests isolated", async () => {
    const cookies = await Promise.all([editorDraft("Alice draft"), editorDraft("Bob draft")]);
    const render = (cookie?: string) => withDevRequest({ headers: { cookie } }, async () => {
      // Suspend both scopes before reading either request's identity.
      await new Promise(resolve => setImmediate(resolve));
      const response = await onRequest(context(), next);
      return { html: await response.text(), cache: response.headers.get("cache-control") };
    });
    const [alice, bob, anonymous] = await Promise.all([render(cookies[0]), render(cookies[1]), render()]);
    expect(alice).toEqual({ html: expect.stringContaining("Alice draft"), cache: "private, no-store" });
    expect(bob.html).toContain("Bob draft");
    expect(anonymous.html).toContain("Published");
    expect(getDevAuthContext(pageRequest(), true)).toBeUndefined();
  });

  it.each(["caret_preview=1", "caret_preview=1; caret_session=invalid", "caret_session=%invalid"])(
    "does not authenticate a preview marker or invalid cookie: %s", async cookie => {
      const ctx = context();
      const response = await withDevRequest({ headers: { cookie } }, () => onRequest(ctx, next));
      expect(ctx.locals.isEditor).toBe(false);
      expect(await response.text()).toContain("Published");
    },
  );

  it("restores headers for authoritative identity while keeping Astro's request URL", async () => {
    const cookie = await editorDraft("Password draft must not be used");
    const authenticate = vi.fn(async (request: Request) =>
      request.headers.get("authorization") === "Bearer test-identity" && request.url === pageRequest().url
        ? { id: "external-editor" } : null);
    __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() }, identityAdapter: { authenticate } });
    await (await adapter.makeEditorOverlay("external-editor")).writeEntry("pages", "home", { headline: "External draft" });
    const response = await withDevRequest({
      headers: { cookie, authorization: "Bearer test-identity" },
    }, () => onRequest(context(), next));
    expect(await response.text()).toContain("External draft");
    const denied = await withDevRequest({ headers: { cookie } }, () => onRequest(context(), next));
    expect(await denied.text()).toContain("Published");
  });

  it.each([false, undefined])("ignores captured credentials outside dev (flag=%s)", async flag => {
    const cookie = await editorDraft("Private draft");
    vi.stubGlobal("__ASTRO_CARET_DEV__", flag);
    const response = await withDevRequest({ headers: { cookie } }, () => onRequest(context(), next));
    expect(await response.text()).toContain("Published");
  });

  it("leaves non-prerendered requests on Astro's normal authentication path", async () => {
    const cookie = await editorDraft("Private draft");
    withDevRequest({ headers: { cookie } }, () => {
      expect(getDevAuthContext(pageRequest(), false)).toBeUndefined();
      expect(getDevAuthContext(pageRequest())).toBeUndefined();
    });
  });
});
