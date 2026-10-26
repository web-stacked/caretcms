import { describe, expect, it, vi } from "vitest";
import { whenServed } from "../../packages/core/static/cms/editor/image-utils.js";

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
