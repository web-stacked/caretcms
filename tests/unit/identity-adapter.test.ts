import { afterEach, describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import { defineIdentityProvider } from "../../packages/core/src/index";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { GET as getSession } from "../../packages/core/src/runtime/routes/auth-session";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";

describe("identity adapter", () => {
  afterEach(() => __setRuntimeServicesForTests(null));

  it("is an authoritative provider reference in integration config", () => {
    expect(defineIdentityProvider({
      entrypoint: "@example/caret-identity",
      exportName: "identityProvider",
      options: { audience: "studio" },
    })).toEqual({
      kind: "identity",
      entrypoint: "@example/caret-identity",
      exportName: "identityProvider",
      options: { audience: "studio" },
    });
  });

  it("authenticates a named editor and exposes metadata from the session endpoint", async () => {
    const identity = {
      id: "editor_01",
      name: "Alex Rivera",
      email: "alex@example.com",
      roles: ["editor"],
    };
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: { upload: vi.fn() },
      identityAdapter: {
        authenticate: vi.fn().mockResolvedValue(identity),
        loginUrl: vi.fn().mockReturnValue("https://login.example.com"),
      },
    });
    const context = {
      locals: {} as Record<string, unknown>,
      request: new Request("http://localhost/api/cms/auth/session"),
      cookies: { get: () => undefined },
    };

    const response = await onRequest(context, () => getSession(context as unknown as APIContext));
    expect(await response.json()).toEqual({ authenticated: true, identity });
    expect(context.locals.isEditor).toBe(true);
    expect(context.locals.caretIdentity).toEqual(identity);
  });

  it("fails closed when an adapter returns an unsafe overlay id", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: { upload: vi.fn() },
      identityAdapter: {
        authenticate: vi.fn().mockResolvedValue({ id: "../escape" }),
        loginUrl: vi.fn().mockReturnValue("https://login.example.com"),
      },
    });
    const context = {
      locals: {} as Record<string, unknown>,
      request: new Request("http://localhost/"),
      cookies: { get: () => undefined },
    };
    const originalError = console.error;
    console.error = vi.fn();
    try {
      await onRequest(context, async () => new Response("ok"));
      expect(context.locals.isEditor).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  it("does not fall back to an old password cookie when identity is authoritative", async () => {
    __setRuntimeServicesForTests({
      adapter: new InMemoryAdapter(),
      uploadHandler: { upload: vi.fn() },
      identityAdapter: {
        authenticate: vi.fn().mockResolvedValue(null),
        loginUrl: vi.fn().mockReturnValue("https://login.example.com"),
      },
    });
    const cookieValue = decodeURIComponent(
      issueEditorSessionCookie().split(";")[0].split("=")[1],
    );
    const context = {
      locals: {} as Record<string, unknown>,
      request: new Request("http://localhost/api/cms/auth/session"),
      cookies: {
        get: (name: string) => name === "caret_session" ? { value: cookieValue } : undefined,
      },
    };
    const response = await onRequest(context, () => getSession(context as unknown as APIContext));
    expect(await response.json()).toEqual({ authenticated: false, identity: null });
    expect(context.locals.isEditor).toBe(false);
  });

  it("attributes history snapshots to the current named editor", async () => {
    const adapter = new InMemoryAdapter();
    const context = {
      adapter,
      uploadHandler: { upload: vi.fn() },
      sessionId: null,
      editorId: "editor_01",
      identity: { id: "editor_01", name: "Alex Rivera", roles: ["editor"] },
      demoMode: false,
      overlayActive: false,
    };
    await runWithRequestContext(context, async () => {
      await executeMutation(adapter, {
        type: "put_entry", collection: "pages", id: "home", data: { title: "First" },
      });
      await executeMutation(adapter, {
        type: "put_entry", collection: "pages", id: "home", data: { title: "Second" },
      });
    });
    expect(await adapter.getHistory("pages", "home")).toMatchObject([
      { editor: { id: "editor_01", name: "Alex Rivera", roles: ["editor"] } },
    ]);
  });
});
