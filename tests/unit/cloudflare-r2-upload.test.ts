import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

class MemoryR2 {
  puts: Array<{ key: string; contentType?: string }> = [];

  async put(
    key: string,
    _value: ReadableStream | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    this.puts.push({ key, contentType: options?.httpMetadata?.contentType });
  }
}

const { envRef } = vi.hoisted(() => ({
  envRef: { current: null as Record<string, unknown> | null },
}));

vi.mock("../../packages/cloudflare/src/runtime/env.js", () => ({
  getCloudflareRuntimeEnv: async () => envRef.current,
}));

import { R2UploadHandler } from "../../packages/cloudflare/src/adapters/r2-upload";

async function pngFile(): Promise<File> {
  const bytes = await readFile(resolve(process.cwd(), "tests/e2e/fixtures/sample.png"));
  return new File([bytes], "sample.png", { type: "image/png" });
}

describe("R2UploadHandler URL contract", () => {
  let bucket: MemoryR2;

  beforeEach(() => {
    bucket = new MemoryR2();
    envRef.current = { CMS_R2: bucket };
  });

  it("uses R2_PUBLIC_DOMAIN and stores the verified content type", async () => {
    envRef.current = { CMS_R2: bucket, R2_PUBLIC_DOMAIN: "assets.example.com/" };
    const result = await new R2UploadHandler().upload(await pngFile());

    expect(result.url).toMatch(/^https:\/\/assets\.example\.com\/.+\.png$/);
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]?.contentType).toBe("image/png");
  });

  it("prefers an explicitly configured publicBaseUrl", async () => {
    envRef.current = { CMS_R2: bucket, R2_PUBLIC_DOMAIN: "ignored.example.com" };
    const result = await new R2UploadHandler({
      publicBaseUrl: "https://cdn.example.com/media/",
    }).upload(await pngFile());

    expect(result.url).toMatch(/^https:\/\/cdn\.example\.com\/media\/.+\.png$/);
  });

  it("allows an explicitly configured development proxy path", async () => {
    const result = await new R2UploadHandler({ devServePath: "/local-r2" })
      .upload(await pngFile());

    expect(result.url).toMatch(/^\/local-r2\/.+\.png$/);
    expect(bucket.puts).toHaveLength(1);
  });

  it("rejects before writing when no servable URL is configured", async () => {
    await expect(new R2UploadHandler().upload(await pngFile())).rejects.toThrow(
      "R2 uploads require publicBaseUrl or R2_PUBLIC_DOMAIN",
    );
    expect(bucket.puts).toHaveLength(0);
  });
});
