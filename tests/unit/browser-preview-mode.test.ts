import { describe, expect, it, vi } from "vitest";
import { createPreviewModeController } from "../../packages/core/static/cms/editor/preview-mode.js";

function setup({ staticDelivery = false, policyDraftMode = false, cookie = "" } = {}) {
  const documentRef = { cookie };
  const reload = vi.fn();
  const controller = createPreviewModeController({
    isStaticDelivery: () => staticDelivery,
    isPolicyDraftMode: () => policyDraftMode,
    documentRef,
    reload,
  });
  return { controller, documentRef, reload };
}

describe("browser preview mode", () => {
  it("enables preview and reloads once for static delivery", () => {
    const { controller, documentRef, reload } = setup({ staticDelivery: true });
    expect(controller.normalizePreviewForDelivery()).toBe(true);
    expect(documentRef.cookie).toBe("caret_preview=1; path=/; SameSite=Lax");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload when static preview is already active", () => {
    const { controller, reload } = setup({
      staticDelivery: true,
      cookie: "session=abc; caret_preview=1",
    });
    expect(controller.normalizePreviewForDelivery()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("clears stale preview state for server delivery", () => {
    const { controller, documentRef, reload } = setup({ cookie: "caret_preview=1" });
    expect(controller.normalizePreviewForDelivery()).toBe(true);
    expect(documentRef.cookie).toBe("caret_preview=; path=/; Max-Age=0; SameSite=Lax");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("leaves policy-managed draft sessions unchanged", () => {
    const { controller, documentRef, reload } = setup({
      policyDraftMode: true,
      cookie: "caret_preview=1",
    });
    expect(controller.normalizePreviewForDelivery()).toBe(false);
    expect(documentRef.cookie).toBe("caret_preview=1");
    expect(reload).not.toHaveBeenCalled();
  });
});
