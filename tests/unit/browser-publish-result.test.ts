import { describe, expect, it } from "vitest";
import { presentPublishResult } from "../../packages/core/static/cms/editor/publish-result.js";

describe("browser publish result presentation", () => {
  it("keeps recovery-required drafts visible", () => {
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [{ collection: "posts", id: "broken", title: "Broken post" }],
      conflicts: [],
      retryAvailable: false,
    })).toEqual({
      completed: false,
      reload: false,
      retryAvailable: false,
      status: { state: "error", text: "Publish didn’t finish" },
      toast: {
        kind: "error",
        message: "“Broken post” couldn’t be published (1 change went through). Your drafts are kept. Try Publish again.",
      },
    });
  });

  it("names every conflicting draft without reloading", () => {
    const result = presentPublishResult({
      published: [],
      failed: [],
      conflicts: [
        { collection: "pages", id: "home", title: "Home" },
        { collection: "posts", id: "hello", title: "Hello world" },
        { collection: "posts", id: "two", title: "Two" },
      ],
    });
    expect(result).toMatchObject({
      completed: false,
      reload: false,
      status: { state: "error", text: "Not published" },
      toast: { kind: "error" },
    });
    // Named as the Studio names them, never by storage keys.
    expect(result.toast.message).toMatch(/^“Home”, “Hello world” and 1 more changed on the site/);
    expect(result.toast.message).not.toContain("pages/home");
  });

  it("surfaces a failed rebuild webhook and preserves its retry action", () => {
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [],
      conflicts: [],
      retryAvailable: true,
      rebuild: { triggered: true, ok: false },
    })).toMatchObject({
      completed: false,
      reload: false,
      retryAvailable: true,
      status: { state: "error", text: "Published, site not updated" },
      toast: { kind: "error", message: expect.stringContaining("couldn’t start updating") },
    });
  });

  it("distinguishes accepted rebuilds, manual deploys, and no-op publishes", () => {
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [], conflicts: [], rebuild: { triggered: true, ok: true },
    })).toMatchObject({
      completed: true, reload: true,
      toast: { kind: "success", message: "Published 1 change. The site is updating; visitors see it in a few minutes." },
    });
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }, { collection: "pages", id: "about" }],
      failed: [], conflicts: [], rebuild: { triggered: false, ok: true }, needsRebuild: true,
    }).toast.message).toBe("Published 2 changes. Visitors see them the next time the site updates.");
    // Content that's live as soon as it's published: no rebuild to mention.
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [], conflicts: [], rebuild: { triggered: false, ok: true },
    }).toast.message).toBe("Published 1 change. Visitors see it now.");
    expect(presentPublishResult({
      published: [], failed: [], conflicts: [], rebuild: { triggered: false, ok: true },
    }).toast.message).toBe("Nothing to publish");
  });

  it("handles malformed optional arrays without throwing", () => {
    expect(presentPublishResult(null)).toMatchObject({
      completed: true,
      reload: true,
      retryAvailable: false,
      toast: { message: "Nothing to publish" },
    });
  });
});

it("reports successful content publication separately from pending Git history", () => {
  expect(presentPublishResult({ published: [{ collection: "blog", id: "hello" }], failed: [], conflicts: [],
    rebuild: { triggered: false, ok: true }, journalRetryAvailable: true })).toMatchObject({ completed: true,
    reload: true, status: { text: "Published, Git history pending" }, toast: { message: expect.stringContaining("Retry Git history") } });
});
