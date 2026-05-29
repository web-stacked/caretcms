import { describe, expect, it } from "vitest";
import { isEditorAuthenticated } from "../../packages/core/src/runtime/auth/session";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import type { UploadHandler } from "../../packages/core/src/types";

const noCookies = { cookies: { get: () => undefined } };

function withDemoContext(overlayActive: boolean, fn: () => void) {
  return runWithRequestContext(
    {
      adapter: new InMemoryAdapter(),
      uploadHandler: {} as UploadHandler,
      sessionId: "11111111-1111-1111-1111-111111111111",
      demoMode: true,
      overlayActive,
    },
    async () => fn(),
  );
}

describe("demo-mode editor auth fails closed without an overlay", () => {
  it("grants editor rights when a session overlay is active", async () => {
    await withDemoContext(true, () => {
      expect(isEditorAuthenticated(noCookies)).toBe(true);
    });
  });

  it("denies editor rights when no overlay was installed", async () => {
    // Without an overlay, writes would land in the shared base store — so an
    // unauthenticated demo visitor must NOT be treated as an editor.
    await withDemoContext(false, () => {
      expect(isEditorAuthenticated(noCookies)).toBe(false);
    });
  });
});
