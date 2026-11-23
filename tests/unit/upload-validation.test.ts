import { describe, expect, it } from "vitest";
import type { APIContext } from "astro";
import { POST } from "../../packages/core/src/runtime/routes/upload";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import {
  IMAGE_MAX_SIZE,
  UPLOAD_MESSAGES,
  UploadError,
  readAndValidateImage,
} from "../../packages/core/src/runtime/storage/image-validation";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import {
  QuotaUploadHandler,
  type QuotaCounter,
} from "../../packages/core/src/runtime/storage/quota-upload-handler";
import type { UploadHandler } from "../../packages/core/src/types";

const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

describe("upload refusals are worded for editors", () => {
  it("names the reason and what to use instead", async () => {
    await expect(readAndValidateImage(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })))
      .rejects.toThrow("This file type can't be used. Use a JPEG, PNG, WebP or AVIF image.");
    await expect(readAndValidateImage(new File([new Uint8Array(IMAGE_MAX_SIZE + 1)], "huge.png", { type: "image/png" })))
      .rejects.toThrow("This image is larger than 10 MB. Use a smaller image.");
    await expect(readAndValidateImage(new File(["just text"], "notes.png", { type: "image/png" })))
      .rejects.toThrow(UPLOAD_MESSAGES.contents);
    await expect(readAndValidateImage(new File([PNG], "photo.jpg", { type: "image/jpeg" })))
      .rejects.toThrow(UPLOAD_MESSAGES.contents);
    await expect(readAndValidateImage(new File([PNG], "dot.png", { type: "image/png" }))).resolves.toMatchObject({ kind: "png" });
  });

  it("never mentions MIME types or formats an editor can't act on", () => {
    for (const message of Object.values(UPLOAD_MESSAGES)) expect(message).not.toMatch(/MIME|declared|R2|publicBaseUrl/);
  });
});

function uploadRequest(): APIContext {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" }));
  return {
    request: new Request("http://localhost/api/cms/upload", {
      method: "POST",
      headers: { "x-caret-request": "1" },
      body: form,
    }),
    cookies: { get: () => undefined },
  } as unknown as APIContext;
}

function callUpload(handler: UploadHandler) {
  return runWithRequestContext(
    {
      adapter: new InMemoryAdapter(),
      uploadHandler: handler,
      sessionId: "11111111-1111-1111-1111-111111111111",
      demoMode: true,
      overlayActive: true,
    },
    () => POST(uploadRequest()),
  );
}

describe("upload route error opacity", () => {
  it("surfaces curated UploadError messages with 400", async () => {
    const res = await callUpload({
      async upload() {
        throw new UploadError("File type not allowed");
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("File type not allowed");
  });

  it("hides unexpected error details behind an opaque 500", async () => {
    const res = await callUpload({
      async upload() {
        throw new Error("EACCES: permission denied, open '/srv/secret/path.png'");
      },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Upload failed");
    expect(body.error).not.toContain("/srv/secret");
  });
});

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

function sizedFile(bytes: number): File {
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
      Array.from({ length: 10 }, () => handler.upload(sizedFile(30), ctx)),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    expect(counter.total("s1")).toBe(90);
    expect(counter.total("s1")).toBeLessThanOrEqual(100);
  });
});
