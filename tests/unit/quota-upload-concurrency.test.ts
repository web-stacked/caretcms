import { describe, expect, it } from "vitest";
import { QuotaUploadHandler } from "../../packages/core/src/runtime/storage/quota-upload-handler";
import type { QuotaCounter } from "../../packages/core/src/runtime/storage/quota-upload-handler";
import type { UploadHandler } from "../../packages/core/src/types";

class MemoryCounter implements QuotaCounter {
  private used = new Map<string, number>();
  async read(sessionId: string): Promise<number> {
    return this.used.get(sessionId) ?? 0;
  }
  async write(sessionId: string, used: number): Promise<void> {
    this.used.set(sessionId, used);
  }
  total(sessionId: string): number {
    return this.used.get(sessionId) ?? 0;
  }
}

// Inner handler that yields control (await) before resolving, so concurrent
// uploads genuinely interleave and would race a read-modify-write counter.
const slowInner: UploadHandler = {
  async upload() {
    await Promise.resolve();
    return { url: "/uploads/x.png" };
  },
};

function file(bytes: number): File {
  return new File([new Uint8Array(bytes)], "x.png", { type: "image/png" });
}

describe("QuotaUploadHandler concurrency", () => {
  it("does not let concurrent uploads overshoot the per-session cap", async () => {
    const counter = new MemoryCounter();
    const handler = new QuotaUploadHandler({
      inner: slowInner,
      counter,
      perSessionBytes: 100,
      perFileBytes: 100,
    });

    const ctx = { sessionId: "s1" };
    // Ten concurrent 30-byte uploads against a 100-byte cap: at most 3 may
    // succeed (90 bytes); the rest must be rejected. A racing RMW counter
    // would let many through and record far less than the real total.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => handler.upload(file(30), ctx)),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    expect(counter.total("s1")).toBe(90);
    expect(counter.total("s1")).toBeLessThanOrEqual(100);
  });
});
