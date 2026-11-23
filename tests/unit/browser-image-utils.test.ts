import { afterEach, describe, expect, it, vi } from "vitest";
import { readUploadUrl } from "../../packages/core/static/cms/editor/image-edit.js";
import { compressImage, whenServed } from "../../packages/core/static/cms/editor/image-utils.js";

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

/** A stand-in image that fails `failures` times, then loads. */
function images(failures: number) {
  const sources: string[] = [];
  const createImage = () => {
    const image = { onload: () => {}, onerror: () => {}, set src(value: string) {
      sources.push(value);
      queueMicrotask(() => (sources.length > failures ? image.onload() : image.onerror()));
    } };
    return image as unknown as HTMLImageElement;
  };
  return { sources, createImage };
}

describe("whenServed", () => {
  it("retries with fresh URLs until the upload is served", async () => {
    vi.useFakeTimers();
    const { sources, createImage } = images(2);
    const served = whenServed("/uploads/new.png", { intervalMs: 100, createImage });
    await vi.advanceTimersByTimeAsync(500);
    await expect(served).resolves.toBe(true);
    expect(sources).toEqual(["/uploads/new.png", "/uploads/new.png?caret-retry=2", "/uploads/new.png?caret-retry=3"]);
    vi.useRealTimers();
  });

  it("gives up after the timeout so the caller can switch anyway", async () => {
    vi.useFakeTimers();
    const { createImage } = images(Infinity);
    const served = whenServed("https://cdn.example/a.png?v=1", { timeoutMs: 1000, intervalMs: 300, createImage });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(served).resolves.toBe(false);
    vi.useRealTimers();
  });
});
