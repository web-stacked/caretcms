import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaretRuntimeConfig } from "../../packages/core/src/runtime/config";
import { resolveStudioDictionary } from "../../packages/core/src/runtime/i18n";
import { placeStudio, renderStudioPage } from "../../packages/core/src/runtime/views/studio-layout";

const runtime: CaretRuntimeConfig = {
  mountPath: "/admin",
  apiBasePath: "/api/cms",
  editorHome: "/",
  mode: "embedded",
  theme: { presetId: null, tokenOverrides: {} },
  brand: { name: "Studio", logo: null, faviconUrl: null },
  locale: "en",
  messages: resolveStudioDictionary("en"),
  inlineEditor: true,
};

function visit(path: string, dest: string | null) {
  const url = new URL(path, "https://site.test");
  const headers = new Headers({ cookie: "caret_session=abc", ...(dest ? { "sec-fetch-dest": dest } : {}) });
  return { request: new Request(url, { headers }), url };
}

/** The site page answers with `status`; records what was asked for. */
function sitePage(status: number) {
  const calls: { url: string; cookie: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL, init?: RequestInit) => {
    calls.push({ url: String(input), cookie: new Headers(init?.headers).get("cookie") });
    return new Response("<html></html>", { status });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("placeStudio", () => {
  it("sends a Studio page opened in a tab to its site page, after checking it as the editor", async () => {
    const calls = sitePage(200);
    const placement = await placeStudio(visit("/admin/cms/pages/about?tab=1", "document"), runtime, "/about");
    expect("redirect" in placement && placement.redirect.status).toBe(303);
    if (!("redirect" in placement)) throw new Error("expected a redirect");
    expect(placement.redirect.headers.get("Location")).toBe(`/about#caret-studio=${encodeURIComponent("/admin/cms/pages/about?tab=1")}`);
    expect(placement.redirect.headers.get("Cache-Control")).toBe("private, no-store");
    expect(calls).toEqual([{ url: "https://site.test/about", cookie: "caret_session=abc" }]);
  });

  it("stays a page, with the reason, when the site page fails for the editor", async () => {
    sitePage(500);
    expect(await placeStudio(visit("/admin/cms/pages/home", "document"), runtime, "/")).toEqual({ siteError: 500 });
    const html = renderStudioPage({ runtime, title: "Home", body: "<p>form</p>", sitePath: "/", siteError: 500 });
    expect(html).toContain('class="studio-site-error" role="alert"');
    expect(html).toContain("(error 500)");
    expect(html).toContain("var overSite = null;");
  });

  it("hands off anyway when the page can't be checked or redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect("redirect" in (await placeStudio(visit("/admin/cms", "document"), runtime))).toBe(true);
    sitePage(302);
    expect("redirect" in (await placeStudio(visit("/admin/cms", "document"), runtime))).toBe(true);
  });

  it("renders as usual inside the drawer, for other requests, and without the inline editor", async () => {
    const calls = sitePage(200);
    expect(await placeStudio(visit("/admin/cms", "iframe"), runtime)).toEqual({ siteError: null });
    expect(await placeStudio(visit("/admin/cms", null), runtime)).toEqual({ siteError: null });
    expect(await placeStudio(visit("/admin/cms", "document"), { ...runtime, inlineEditor: false })).toEqual({ siteError: null });
    expect(calls).toEqual([]);
  });
});
