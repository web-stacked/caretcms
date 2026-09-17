import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";

declare const __ASTRO_CARET_DEV__: boolean | undefined;

type DevRequest = Pick<IncomingMessage, "headers">;

// Integration hooks and Vite's runtime can evaluate separate module copies.
// As with request-context.ts, share the scope, never a current-request variable.
const key = Symbol.for("@caretcms/core/dev-request-context");
const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
const storage = (slots[key] ??= new AsyncLocalStorage<DevRequest>()) as AsyncLocalStorage<DevRequest>;

/** Installed only on the static authoring dev server, before Astro strips
 * headers from prerendered routes. Keeping the route prerendered preserves
 * getStaticPaths props and the production static build. */
export function withDevRequest<T>(request: DevRequest, next: () => T): T {
  return storage.run(request, next);
}

/** Restore request identity for Caret only; do not change Astro's page context
 * or accept a browser-supplied header as proof of authentication. */
export function getDevAuthContext(request: Request | undefined, isPrerendered?: boolean) {
  if (typeof __ASTRO_CARET_DEV__ !== "boolean" || !__ASTRO_CARET_DEV__ || !isPrerendered || !request) {
    return undefined;
  }
  const incoming = storage.getStore();
  if (!incoming || (request.method !== "GET" && request.method !== "HEAD")) return undefined;

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (name.startsWith(":") || value === undefined) continue;
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else headers.set(name, value);
  }
  const cookies = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (cookies.has(name)) continue;
    const value = part.slice(separator + 1).trim();
    try { cookies.set(name, decodeURIComponent(value)); }
    catch { cookies.set(name, value); }
  }
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
    }),
    cookies: {
      get(name: string) {
        const value = cookies.get(name);
        return value === undefined ? undefined : { value };
      },
    },
  };
}
