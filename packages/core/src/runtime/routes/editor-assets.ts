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
  // copy hides edits. In prod, cache for an hour (these are static package
  // files that only change on a package update).
  const cacheControl =
    process.env.NODE_ENV === "development"
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=3600";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": getMimeType(safePath),
      "Cache-Control": cacheControl,
    },
  });
}
