import { describe, expect, it } from "vitest";
import { presentPublishResult } from "../../packages/core/static/cms/editor/publish-result.js";

describe("browser publish result presentation", () => {
  it("keeps recovery-required drafts visible", () => {
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [{ collection: "posts", id: "broken" }],
      conflicts: [],
      retryAvailable: false,
    })).toEqual({
      completed: false,
      reload: false,
      retryAvailable: false,
      status: { state: "error", text: "Publish needs recovery" },
      toast: {
        kind: "error",
        message: "Finished 1 change(s); 1 need recovery. Some content may already be published. Retry Publish after checking storage. Drafts are kept.",
      },
    });
  });

  it("names every conflicting draft without reloading", () => {
    const result = presentPublishResult({
      published: [],
      failed: [],
      conflicts: [
        { collection: "pages", id: "home" },
        { collection: "posts", id: "hello" },
      ],
    });
    expect(result).toMatchObject({
      completed: false,
      reload: false,
      status: { state: "error", text: "Draft conflict" },
      toast: { kind: "error" },
    });
    expect(result.toast.message).toContain("pages/home, posts/hello");
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
      status: { state: "error", text: "Published, deploy failed" },
      toast: { kind: "error", message: expect.stringContaining("deploy webhook failed") },
    });
  });

  it("distinguishes accepted rebuilds, manual deploys, and no-op publishes", () => {
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [], conflicts: [], rebuild: { triggered: true, ok: true },
    })).toMatchObject({
      completed: true, reload: true,
      toast: { kind: "success", message: "Published 1 change(s) — rebuild started" },
    });
    expect(presentPublishResult({
      published: [{ collection: "pages", id: "home" }],
      failed: [], conflicts: [], rebuild: { triggered: false, ok: true },
    }).toast.message).toBe("Published 1 change(s) — rebuild and deploy to update visitors");
    expect(presentPublishResult({
      published: [], failed: [], conflicts: [], rebuild: { triggered: false, ok: true },
    }).toast.message).toBe("Already up to date");
  });

  it("handles malformed optional arrays without throwing", () => {
    expect(presentPublishResult(null)).toMatchObject({
      completed: true,
      reload: true,
      retryAvailable: false,
      toast: { message: "Already up to date" },
    });
  });
});
