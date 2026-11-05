import { describe, expect, it } from "vitest";
import type { CaretRuntimeConfig } from "../../packages/core/src/runtime/config";
import { resolveStudioDictionary } from "../../packages/core/src/runtime/i18n";
import { studioOverSite } from "../../packages/core/src/runtime/views/studio-layout";

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
  const headers = new Headers(dest ? { "sec-fetch-dest": dest } : {});
  return { request: new Request(url, { headers }), url };
}

describe("studioOverSite", () => {
  it("sends a Studio page opened in a tab to its site page with the route", () => {
    const response = studioOverSite(visit("/admin/cms/pages/about?tab=1", "document"), runtime, "/about");
    expect(response?.status).toBe(303);
    expect(response?.headers.get("Location")).toBe(`/about#caret-studio=${encodeURIComponent("/admin/cms/pages/about?tab=1")}`);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("defaults to the editor home and drops a fragment from the site path", () => {
    expect(studioOverSite(visit("/admin/cms", "document"), runtime)?.headers.get("Location"))
      .toBe(`/#caret-studio=${encodeURIComponent("/admin/cms")}`);
    expect(studioOverSite(visit("/admin/cms", "document"), runtime, "/menu#top")?.headers.get("Location"))
      .toBe(`/menu#caret-studio=${encodeURIComponent("/admin/cms")}`);
  });

  it("renders as usual inside the drawer, for other requests, and without the inline editor", () => {
    expect(studioOverSite(visit("/admin/cms", "iframe"), runtime)).toBeNull();
    expect(studioOverSite(visit("/admin/cms", null), runtime)).toBeNull();
    expect(studioOverSite(visit("/admin/cms", "document"), { ...runtime, inlineEditor: false })).toBeNull();
  });
});
