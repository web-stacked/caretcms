import { afterEach, describe, expect, it, vi } from "vitest";
import { readUploadUrl } from "../../packages/core/static/cms/editor/image-edit.js";
import { compressImage } from "../../packages/core/static/cms/editor/image-utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inline image browser utilities", () => {
  it("normalizes successful upload URLs and rejects malformed response bodies", () => {
    expect(readUploadUrl({ url: " /uploads/photo.webp " })).toBe("/uploads/photo.webp");
    expect(readUploadUrl({ url: "" })).toBeNull();
    expect(readUploadUrl({ ok: true })).toBeNull();
    expect(readUploadUrl([])).toBeNull();
    expect(readUploadUrl(null)).toBeNull();
  });

  it("keeps an already-small WebP without decoding it", async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = new File([new Uint8Array(10)], "photo.webp", { type: "image/webp" });

    await expect(compressImage(file)).resolves.toBe(file);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("falls back to the original image when a 2D canvas context is unavailable", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 2400,
      height: 1200,
      close,
    }));
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => null,
      })),
    });
    const file = new File([new Uint8Array(210_000)], "photo.jpg", { type: "image/jpeg" });

    await expect(compressImage(file)).resolves.toBe(file);
    expect(close).toHaveBeenCalledOnce();
  });
});
