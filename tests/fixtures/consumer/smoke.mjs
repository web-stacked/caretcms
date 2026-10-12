import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dev } from "astro";
import { caretLoader } from "@caretcms/core/loader";
import { validateJsonSchema } from "@caretcms/core/schema-utils";
import { InMemoryAdapter } from "@caretcms/core";
import { runStorageConformance } from "@caretcms/core/testing/storage";

assert.equal(typeof caretLoader("pages").loadEntry, "function");
assert.equal(validateJsonSchema({ title: 1 }, { type: "object", properties: { title: { type: "string" } } }).length, 1);
const conformance = await runStorageConformance(async () => ({ adapter: new InMemoryAdapter() }));
assert.deepEqual(conformance.filter(result => result.status === "failed"), []);
const server = await dev({ root: process.cwd(), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
try {
  const origin = `http://127.0.0.1:${server.address.port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(15_000) });
  const session = await request("/api/cms/auth/session");
  assert.equal(session.status, 200);
  assert.match(session.headers.get("cache-control"), /private.*no-store/);
  await session.text();
  const anonymous = await request("/");
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /<p\b[^>]*\bid="live-title"[^>]*>Published title/);
  const login = await request("/api/cms/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "consumer-fixture" }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = `${login.headers.get("set-cookie").split(";")[0]}; caret_preview=1`;
  const headers = { cookie, "content-type": "application/json", "x-caret-request": "1" };
  const read = await request("/api/cms/entries?collection=pages&id=home", { headers });
  assert.equal(read.status, 200);
  const entry = (await read.json()).entries[0];
  assert.equal(entry.data.title, "Published title");
  assert.equal(entry.revision, 0);
  assert.equal(entry.baseRevision, 0);
  const save = (data, revision = 0) => request("/api/cms/mutate", {
    method: "POST", headers, body: JSON.stringify({ type: "put_entry", collection: "pages", id: "home",
      data, expectedRevision: revision, expectedBaseRevision: entry.baseRevision }),
  });
  const invalid = await save({ title: 42 });
  assert.equal(invalid.status, 400, await invalid.text());
  const saved = await save({ title: "Consumer approved title" });
  assert.equal(saved.status, 200, await saved.text());
  const stale = await save({ title: "Stale title" });
  assert.equal(stale.status, 409, await stale.text());
  const published = await request("/api/cms/publish", { method: "POST", headers, body: JSON.stringify({ collection: "pages", id: "home" }) });
  assert.equal(published.status, 200);
  const result = await published.json();
  assert.equal(result.published.length, 1);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.journalSources, undefined);
  assert.equal(JSON.parse(await readFile("data/pages/home.json", "utf8")).title, "Consumer approved title");
  const editor = await request("/", { headers });
  assert.equal(editor.status, 200);
  assert.match(editor.headers.get("cache-control"), /private.*no-store/);
  const editorHtml = await editor.text();
  assert.match(editorHtml, /Consumer approved title/);
  assert.match(editorHtml, /<p\b[^>]*\bid="live-title"[^>]*>Consumer approved title/);
  // These raw assets are part of the published package, not TypeScript's dist.
  for (const asset of ["editor.js", "editor.css", "studio/history-client.js"]) {
    const response = await request(`/__caret/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 20, asset);
  }
} finally {
  await server.stop();
}
console.log("Packed consumer passed: exports, live loader, auth, versions, validation, publish, and assets");
