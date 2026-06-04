import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import {
  hasStega,
  stegaCombine,
  stegaDecode,
} from "../../packages/core/src/runtime/stega";

describe("middleware", () => {
  beforeEach(() => {
    __setRuntimeServicesForTests(null);
  });

  it("injects configured services and rewrites HTML responses", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.writeEntry("pages", "home", { title: "Stored Title" });

    const uploadHandler = {
      upload: vi.fn(),
    };

    __setRuntimeServicesForTests({
      adapter,
      uploadHandler,
    });

    const context = {
      locals: {} as Record<string, unknown>,
      cookies: {
        get: () => undefined,
      },
    };

    const response = await onRequest(context, async () => {
      return new Response(
        '<section data-caret-scope="pages::home"><h1 data-caret="title">Default Title</h1></section>',
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": "99",
          },
        },
      );
    });

    expect(context.locals.isEditor).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);

    const html = await response.text();
    expect(html).toContain("Stored Title");
    expect(html).not.toContain("Default Title");
  });

  it("passes through non-HTML responses untouched", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: {
        upload: vi.fn(),
      },
    });

    const context = {
      locals: {} as Record<string, unknown>,
      cookies: {
        get: () => undefined,
      },
    };

    const response = await onRequest(context, async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("fast-paths HTML with no CMS bindings", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: {
        upload: vi.fn(),
      },
    });

    const context = {
      locals: {} as Record<string, unknown>,
      cookies: {
        get: () => undefined,
      },
    };

    const response = await onRequest(context, async () => {
      return new Response("<html><body><h1>No bindings</h1></body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": "44",
          "x-test": "preserved",
        },
      });
    });

    expect(await response.text()).toBe("<html><body><h1>No bindings</h1></body></html>");
    expect(response.headers.get("content-length")).toBe("44");
    expect(response.headers.get("x-test")).toBe("preserved");
  });

  it("passes through compressed HTML responses without decoding", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.writeEntry("pages", "home", { title: "Stored Title" });
    __setRuntimeServicesForTests({
      adapter,
      uploadHandler: { upload: vi.fn() },
    });

    const context = {
      locals: {} as Record<string, unknown>,
      cookies: { get: () => undefined },
    };

    // Simulated brotli-compressed body — calling .text() on this and
    // re-serializing would corrupt it. Middleware must leave it alone.
    const compressedBytes = new Uint8Array([0x1b, 0x2c, 0x00, 0x00, 0xa4]);
    const response = await onRequest(context, async () => {
      return new Response(compressedBytes, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "br",
          "content-length": String(compressedBytes.byteLength),
        },
      });
    });

    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-length")).toBe(String(compressedBytes.byteLength));
    const received = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(compressedBytes));
  });

  it("marks the request as editor-authenticated when the session cookie is valid", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: {
        upload: vi.fn(),
      },
    });

    const cookieValue = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
    const context = {
      locals: {} as Record<string, unknown>,
      cookies: {
        get: (name: string) => {
          if (name !== "caret_session") return undefined;
          return { value: cookieValue };
        },
      },
    };

    await onRequest(context, async () => {
      return new Response("<html><body><h1>No bindings</h1></body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    });

    expect(context.locals.isEditor).toBe(true);
  });

  it("strips stega metadata from published HTML for non-editors", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: { upload: vi.fn() },
    });

    const context = {
      locals: {} as Record<string, unknown>,
      cookies: { get: () => undefined },
    };

    // Stega-encoded text with NO data-caret attribute: the backstop must still
    // clean it (independent of the rewrite path).
    const encoded = stegaCombine("Professional Websites", "pages::home::hero_title");
    const response = await onRequest(context, async () => {
      return new Response(`<h1>${encoded}</h1>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    expect(context.locals.isEditor).toBe(false);
    const html = await response.text();
    expect(hasStega(html)).toBe(false);
    expect(html).toContain("Professional Websites");
  });

  it("preserves stega metadata for an authenticated editor", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: { upload: vi.fn() },
    });

    const cookieValue = decodeURIComponent(
      issueEditorSessionCookie().split(";")[0].split("=")[1],
    );
    const context = {
      locals: {} as Record<string, unknown>,
      cookies: {
        get: (name: string) =>
          name === "caret_session" ? { value: cookieValue } : undefined,
      },
    };

    const encoded = stegaCombine("Professional Websites", "pages::home::hero_title");
    const response = await onRequest(context, async () => {
      return new Response(`<h1>${encoded}</h1>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    expect(context.locals.isEditor).toBe(true);
    const html = await response.text();
    expect(hasStega(html)).toBe(true);
    expect(stegaDecode(html)).toBe("pages::home::hero_title");
  });
});
