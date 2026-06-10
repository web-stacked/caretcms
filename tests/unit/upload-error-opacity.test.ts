import { describe, expect, it } from "vitest";
import type { APIContext } from "astro";
import { POST } from "../../packages/core/src/runtime/routes/upload";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { UploadError } from "../../packages/core/src/runtime/storage/image-validation";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import type { UploadHandler } from "../../packages/core/src/types";

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
