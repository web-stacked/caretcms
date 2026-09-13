import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(injected: Record<string, unknown>, storedToken: string | null = null) {
  vi.resetModules();
  const localStorage = {
    getItem: vi.fn(() => storedToken),
    removeItem: vi.fn(),
  };
  vi.stubGlobal("window", {
    __CARET__: injected,
    location: { origin: "https://site.test", href: "https://site.test/page" },
    localStorage,
  });
  return { config: await import("../../packages/core/static/cms/editor/config.js"), localStorage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser runtime config", () => {
  it("falls back safely for malformed injected paths and modes", async () => {
    const { config } = await loadConfig({ mode: 42, mountPath: " ", apiBasePath: null });
    expect(config.CMS_MODE).toBe("embedded");
    expect(config.MOUNT_PATH).toBe("/admin");
    expect(config.API_BASE).toBe("/api/cms");
    expect(config.buildCmsUrl("entries")).toBe("https://site.test/api/cms/entries");
  });

  it("normalizes cloud endpoints and builds project-scoped URLs", async () => {
    const { config } = await loadConfig({
      mode: "cloud",
      cloud: {
        endpoint: "https://cms.test/",
        projectId: " project-1 ",
        contentPath: "v1/content/",
        environment: " preview ",
      },
    });
    expect(config.buildCmsUrl("entries", { collection: "pages" })).toBe(
      "https://cms.test/v1/content/entries?projectId=project-1&environment=preview&collection=pages",
    );
    expect(config.getEditorLoginUrl("https://site.test/page")).toBe(
      "https://cms.test/v1/content/admin?projectId=project-1&redirect=https%3A%2F%2Fsite.test%2Fpage",
    );
  });

  it("reads and clears the project-scoped cloud session token", async () => {
    const { config, localStorage } = await loadConfig({
      mode: "cloud",
      cloud: { endpoint: "https://cms.test", projectId: "project-1" },
    }, " token ");
    expect(config.getCloudSessionToken()).toBe("token");
    config.clearCloudSessionToken();
    expect(localStorage.removeItem).toHaveBeenCalledWith(
      "caretcms:cloud-session:https://cms.test:project-1",
    );
  });
});
