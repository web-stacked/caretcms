import { describe, expect, it } from "vitest";
import {
  enforceContentLength,
  readJsonBody,
  MAX_JSON_BODY_BYTES,
} from "../../packages/core/src/runtime/routes/_helpers";

describe("request body size limits", () => {
  it("rejects an oversized declared Content-Length with 413", () => {
    const req = new Request("http://localhost/api/cms/mutate", {
      method: "POST",
      headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
      body: "{}",
    });
    const res = enforceContentLength(req, MAX_JSON_BODY_BYTES);
    expect(res?.status).toBe(413);
  });

  it("parses a small JSON body", async () => {
    const req = new Request("http://localhost/api/cms/mutate", {
      method: "POST",
      body: JSON.stringify({ type: "save_field" }),
    });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ type: "save_field" });
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new Request("http://localhost/api/cms/mutate", {
      method: "POST",
      body: "{ not json",
    });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("streams and rejects a body that exceeds the cap with no Content-Length", async () => {
    // A chunked flood without an honest Content-Length must still be cut off
    // by the streaming byte counter rather than buffered unbounded.
    const cap = 64;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(32));
        for (let i = 0; i < 10; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/cms/mutate", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required by undici for a stream body
      duplex: "half",
    });
    const result = await readJsonBody(req, cap);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });
});
