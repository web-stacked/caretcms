import { describe, expect, it, vi } from "vitest";
import { createStudioUploadClient, StudioUploadError } from "../../packages/core/static/cms/studio/upload-client.js";

function image(name = "photo.webp", type = "image/webp", size = 10) {
  return new File([new Uint8Array(size)], name, { type });
}

describe("Studio upload client", () => {
  it("uploads a prepared file with same-origin editor headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "/uploads/photo.webp" }));
    const file = image();
    const api = createStudioUploadClient({ apiBasePath: "/api/cms", fetchImpl });
    await expect(api.upload(file)).resolves.toBe("/uploads/photo.webp");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/cms/upload");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "x-caret-request": "1" } });
    expect((init?.body as FormData).get("file")).toEqual(file);
  });

  it("scales reported dimensions to the preparation width", async () => {
    const close = vi.fn();
    const api = createStudioUploadClient({
      apiBasePath: "/api/cms",
      createBitmap: vi.fn().mockResolvedValue({ width: 3200, height: 1800, close }),
    });
    await expect(api.readDimensions(image("photo.jpg", "image/jpeg")))
      .resolves.toEqual({ width: 1600, height: 900 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("resizes large images and keeps a smaller encoded result", async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(["small"], { type: "image/webp" }))),
    } as unknown as HTMLCanvasElement;
    const api = createStudioUploadClient({
      apiBasePath: "/api/cms",
      createBitmap: vi.fn().mockResolvedValue({ width: 3200, height: 1800, close }),
      createCanvas: () => canvas,
    });
    const prepared = await api.compress(image("large.jpg", "image/jpeg", 300000));
    expect({ name: prepared.name, type: prepared.type, width: canvas.width, height: canvas.height })
      .toEqual({ name: "large.webp", type: "image/webp", width: 1600, height: 900 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 900);
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends a file it can't decode unchanged, so the server can say why", async () => {
    const api = createStudioUploadClient({
      apiBasePath: "/api/cms",
      createBitmap: vi.fn().mockRejectedValue(new Error("decode failed")),
    });
    const file = image("notes.png", "image/png", 300000);
    await expect(api.compress(file)).resolves.toBe(file);
  });

  it("returns null when dimensions cannot be decoded", async () => {
    const api = createStudioUploadClient({
      apiBasePath: "/api/cms",
      createBitmap: vi.fn().mockRejectedValue(new Error("decode failed")),
    });
    await expect(api.readDimensions(image())).resolves.toBeNull();
  });

  it("reports authorization, HTTP, and malformed response failures", async () => {
    const onUnauthorized = vi.fn();
    const api = createStudioUploadClient({
      apiBasePath: "/api/cms",
      onUnauthorized,
      fetchImpl: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(Response.json({ error: "This image is larger than 10 MB. Use a smaller image." }, { status: 400 }))
        .mockResolvedValueOnce(Response.json({ ok: true })),
    });
    await expect(api.upload(image())).rejects.toMatchObject({ kind: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    await expect(api.upload(image())).rejects.toBeInstanceOf(StudioUploadError);
    // The server's reason is kept for the editor.
    await expect(api.upload(image())).rejects.toMatchObject({ kind: "failed", reason: "This image is larger than 10 MB. Use a smaller image." });
    await expect(api.upload(image())).rejects.toMatchObject({ kind: "invalid-response" });
  });
});
