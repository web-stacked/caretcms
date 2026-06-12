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

  describe("authenticated empty-state hint", () => {
    function authedContext(url: string) {
      const cookieValue = decodeURIComponent(
        issueEditorSessionCookie().split(";")[0].split("=")[1],
      );
      return {
        locals: {} as Record<string, unknown>,
        request: new Request(url),
        cookies: {
          get: (name: string) =>
            name === "caret_session" ? { value: cookieValue } : undefined,
        },
      };
    }

    const PLAIN_PAGE = "<html><body><h1>No bindings here</h1></body></html>";

    function serveServices(overrides: Record<string, unknown> = {}) {
      __setRuntimeServicesForTests({
        adapter: new InMemoryAdapter(),
        uploadHandler: { upload: vi.fn() },
        enableInlineEditor: true,
        ...overrides,
      });
    }

    it("injects the hint for an authed editor on a binding-less live page", async () => {
      serveServices();
      const response = await onRequest(authedContext("http://localhost/about"), async () =>
        new Response(PLAIN_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
      const html = await response.text();
      expect(html).toContain("caret-signin-hint");
      expect(html).toContain("/__caret/signin-hint.css");
      // Injected before </body>, exactly once.
      expect(html.indexOf("caret-signin-hint")).toBeLessThan(html.indexOf("</body>"));
      expect(html.match(/caret-signin-hint"/g)?.length).toBe(1);
    });

    it("does not inject for an unauthenticated visitor", async () => {
      serveServices();
      const response = await onRequest(
        { locals: {}, request: new Request("http://localhost/about"), cookies: { get: () => undefined } },
        async () =>
          new Response(PLAIN_PAGE, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      );
      expect(await response.text()).not.toContain("caret-signin-hint");
    });

    it("does not inject when the page already has bindings", async () => {
      serveServices();
      const response = await onRequest(authedContext("http://localhost/about"), async () =>
        new Response('<h1 data-caret="pages::home::title">Hi</h1>', {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
      expect(await response.text()).not.toContain("caret-signin-hint");
    });

    it("injects when the page only MENTIONS data-caret in prose (no attributes)", async () => {
      serveServices();
      const prosePage =
        "<html><body><h1>A page about data-caret bindings</h1>" +
        "<p>Annotate HTML with <code>data-caret</code> attributes.</p></body></html>";
      const response = await onRequest(authedContext("http://localhost/docs"), async () =>
        new Response(prosePage, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
      // The substring probe used to count prose as bindings, suppressing the
      // hint and running the rewrite engine on pages with nothing to rewrite.
      expect(await response.text()).toContain("caret-signin-hint");
    });

    it("treats a scope attribute as bindings", async () => {
      serveServices();
      const response = await onRequest(authedContext("http://localhost/about"), async () =>
        new Response('<main data-caret-scope="pages::home"><h1>Hi</h1></main>', {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
      expect(await response.text()).not.toContain("caret-signin-hint");
    });

    it("does not inject on CMS-owned pages (the Studio)", async () => {
      serveServices({ mountPath: "/admin" });
      const response = await onRequest(authedContext("http://localhost/admin/cms"), async () =>
        new Response(PLAIN_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
      expect(await response.text()).not.toContain("caret-signin-hint");
    });

    it("does not inject when the inline editor is disabled", async () => {
      serveServices({ enableInlineEditor: false });
      const response = await onRequest(authedContext("http://localhost/about"), async () =>
        new Response(PLAIN_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
      expect(await response.text()).not.toContain("caret-signin-hint");
    });
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
