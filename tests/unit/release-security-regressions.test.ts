import { afterEach, expect, it, vi } from "vitest";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { hasCaretBindings } from "../../packages/core/src/runtime/html-tokens";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { BODY_OVERLAY_KEY } from "../../packages/core/src/markdown/contracts";
import { readFormBody } from "../../packages/core/src/runtime/routes/_helpers";
import { POST as login } from "../../packages/core/src/runtime/routes/auth-login";

vi.mock("../../packages/core/src/runtime/config.js", () => ({ getRuntimeConfig: () => ({ mountPath: "/admin", apiBasePath: "/api/cms", editorHome: "/" }) }));

afterEach(() => { vi.unstubAllEnvs(); __setRuntimeServicesForTests(null); });

it.each([
  '<script>const template=\'<p data-caret="pages::home::title">Original</p>\';</script>',
  '<script/>const template=\'<p data-caret="pages::home::title">Original</p>\';</script>',
  '<style>/* <p data-caret="pages::home::title">Original</p> */</style>',
  '<textarea><p data-caret="pages::home::title">Original</p></textarea>',
  '<title><p data-caret="pages::home::title">Original</p></title>',
  '<!-- <p data-caret="pages::home::title">Original</p> -->',
  '<div title=\'<p data-caret="pages::home::title">Original</p>\'>Text</div>',
  '<iframe><p data-caret="pages::home::title">Original</p></iframe>',
  '<plaintext><p data-caret="pages::home::title">Original</p>',
  '<svg><p data-caret="pages::home::title">Original</p></svg>',
  '</3 <p data-caret="pages::home::title">Original</p>',
  '</ <p data-caret="pages::home::title">Original</p>',
  '<!--!> <p data-caret="pages::home::title">Original</p> -->',
])("never rewrites bindings in a non-HTML editing context: %s", async html => {
  const adapter = new InMemoryAdapter();
  await adapter.writeEntry("pages", "home", { title: "';globalThis.reviewMarker=1;//" });
  expect(await rewriteCaretAttributes(html, adapter)).toBe(html);
});

it("uses actual attributes and the real opening-tag boundary", async () => {
  const adapter = new InMemoryAdapter();
  await adapter.writeEntry("pages", "home", { title: "Stored", image: "/new.png" });
  expect(await rewriteCaretAttributes('<p title="a>b" data-caret="pages::home::title">Old</p>', adapter))
    .toBe('<p title="a>b" data-caret="pages::home::title">Stored</p>');
  const fake = '<p title=\'data-caret="pages::home::title"\'>Old</p>';
  expect(await rewriteCaretAttributes(fake, adapter)).toBe(fake);
  expect(hasCaretBindings(fake)).toBe(false);
  expect(await rewriteCaretAttributes('<img title=\'src="fake"\' data-caret="pages::home::image" src="/old.png">', adapter))
    .toBe('<img title=\'src="fake"\' data-caret="pages::home::image" src="/new.png">');
});

it.each(["<!-->", "<!--->", "</>"])("still rewrites bindings after the empty markup %s", async prefix => {
  const adapter = new InMemoryAdapter();
  await adapter.writeEntry("pages", "home", { title: "Stored" });
  expect(await rewriteCaretAttributes(`${prefix}<p data-caret="pages::home::title">Old</p>`, adapter))
    .toBe(`${prefix}<p data-caret="pages::home::title">Stored</p>`);
});

function authedContext() {
  const value = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
  return { locals: {}, request: new Request("http://localhost/"), cookies: { get: (name: string) => name === "caret_session" ? { value } : undefined } };
}

it("previews a Markdown-only page and keeps its response private", async () => {
  const adapter = new InMemoryAdapter();
  const context = authedContext();
  __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() } });
  // Resolve the persistent editor id from the same cookie used by middleware.
  const { getEditorId } = await import("../../packages/core/src/runtime/auth/session");
  const overlay = await adapter.makeEditorOverlay(getEditorId(context)!);
  await overlay.writeEntry("pages", "home", { [BODY_OVERLAY_KEY]: { "0": { html: "Draft", md: "Draft" } } });
  const response = await onRequest(context, async () => new Response('<p data-caret-md="pages::home::body::0">Original</p>', {
    headers: { "content-type": "text/html", "cache-control": "public, s-maxage=3600", etag: '"source"' },
  }));
  expect(await response.text()).toContain("Draft");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.has("etag")).toBe(false);
});

it("protects non-HTML editor responses and strips source conditionals before render", async () => {
  __setRuntimeServicesForTests({ adapter: new InMemoryAdapter(), uploadHandler: { upload: vi.fn() } });
  const context = authedContext();
  context.request = new Request(context.request, { headers: { "if-none-match": '"source"' } });
  const response = await onRequest(context, async () => {
    expect(context.request.headers.has("if-none-match")).toBe(false);
    return new Response('{"draft":true}', { headers: { "content-type": "application/json", "cache-control": "public", "cdn-cache-control": "public", etag: '"source"' } });
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.has("cdn-cache-control")).toBe(false);
  expect(response.headers.has("etag")).toBe(false);
});

it("retains public cache directives but drops validators when anonymous HTML changes", async () => {
  const adapter = new InMemoryAdapter(); await adapter.writeEntry("pages", "home", { title: "Live" });
  __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() } });
  const response = await onRequest({ locals: {}, request: new Request("http://localhost/") }, async () => new Response('<p data-caret="pages::home::title">Source</p>', {
    headers: { "content-type": "text/html", "cache-control": "public, max-age=60", etag: '"source"' },
  }));
  expect(await response.text()).toContain("Live");
  expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  expect(response.headers.has("etag")).toBe(false);
});

it.each(["application/json", "application/x-www-form-urlencoded"])("enforces login limits with no Content-Length (%s)", async contentType => {
  vi.stubEnv("CARET_EDIT_PASSWORD", "test-password");
  __setRuntimeServicesForTests({ adapter: new InMemoryAdapter(), uploadHandler: { upload: vi.fn() } });
  const padding = "x".repeat(1024 * 1024);
  const body = contentType === "application/json" ? JSON.stringify({ password: "wrong", padding }) : `password=wrong&padding=${padding}`;
  const request = new Request("http://localhost/api/cms/auth/login", { method: "POST", headers: { "content-type": contentType }, body });
  const response = await login({ request, url: new URL(request.url) } as never);
  expect(response.status).toBe(413);
});

it("bounds form streams before parsing and cancels an oversized stream", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(32)); }, cancel() { canceled = true; } });
  const request = new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half" } as RequestInit);
  const result = await readFormBody(request, 64);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(413);
  expect(canceled).toBe(true);
});

it("preserves bounded multipart binary data and accepts a form exactly at its byte limit", async () => {
  const form = new FormData(); form.set("file", new File([new Uint8Array([0, 255, 128])], "data.bin"));
  const result = await readFormBody(new Request("http://localhost/", { method: "POST", body: form }), 4096);
  expect(result.ok).toBe(true);
  if (result.ok) expect(new Uint8Array(await (result.value.get("file") as File).arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  const exact = await readFormBody(new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=%C3%A9" }), 8);
  expect(exact.ok).toBe(true);
  if (exact.ok) expect(exact.value.get("a")).toBe("é");
});
