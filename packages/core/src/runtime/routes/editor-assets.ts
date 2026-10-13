export const prerender = false;

import type { APIContext } from "astro";

// Bundle every static asset as a raw string at build time. The literal
// import.meta.glob call is transformed by Vite into an inline Object.assign of
// raw file contents, so the route works on Node and Cloudflare Workers without
// runtime filesystem access. The try/catch handles the plain-Node import path
// (e.g. astro.config.mjs loading) where import.meta.glob is undefined.
type GlobMap = Record<string, unknown>;
let _assetModules: GlobMap | null = null;
function getAssetModules(): GlobMap {
  if (_assetModules) return _assetModules;
  try {
    // @ts-expect-error Vite injects `glob` on import.meta at build time.
    _assetModules = import.meta.glob(
      "../../../static/cms/**/*.{js,css,json,svg}",
      { eager: true, query: "?raw", import: "default" },
    ) as GlobMap;
  } catch {
    _assetModules = {};
  }
  return _assetModules;
}

const ASSET_KEY_PREFIX = "../../../static/cms/";
let _assets: Record<string, string> | null = null;
function getAssets(): Record<string, string> {
  if (_assets) return _assets;
  const built: Record<string, string> = {};
  for (const [path, body] of Object.entries(getAssetModules())) {
    if (typeof body !== "string") continue;
    const key = path.startsWith(ASSET_KEY_PREFIX)
      ? path.slice(ASSET_KEY_PREFIX.length)
      : path;
    built[key] = body;
  }
  _assets = built;
  return _assets;
}

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// Content hashes for ETags. The assets @import one another by unversioned URLs,
// so a long max-age would let an upgraded page pair new markup with stale CSS.
export function contentEtag(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `"${(hash >>> 0).toString(36)}-${body.length.toString(36)}"`;
}

const etags = new Map<string, string>();
function etagFor(path: string, body: string): string {
  let tag = etags.get(path);
  if (!tag) {
    tag = contentEtag(body);
    etags.set(path, tag);
  }
  return tag;
}

function sanitizePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.includes("\0")) return null;
  if (/[^a-zA-Z0-9_./-]/.test(normalized)) return null;
  return normalized;
}

export async function GET(context: APIContext): Promise<Response> {
  const rawPath = (context.params.path ?? "").toString();
  const safePath = sanitizePath(rawPath);
  if (!safePath) {
    return new Response("Not found", { status: 404 });
  }

  const body = getAssets()[safePath];
  if (body === undefined) {
    return new Response("Not found", { status: 404 });
  }

  // In dev, never cache — editor source files change frequently and a cached
  // copy hides edits. In prod, revalidate every use: an unchanged file costs a
  // 304, and a package upgrade is picked up immediately.
  const development = process.env.NODE_ENV === "development";
  const cacheControl = development ? "no-cache, no-store, must-revalidate" : "public, no-cache";
  const etag = etagFor(safePath, body);
  if (!development && context.request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": getMimeType(safePath),
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}
