import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "astro";

await build({ root: process.cwd(), logLevel: "error" });

async function start() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
    cwd: process.cwd(), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", launchError;
  const collect = chunk => { output += chunk.toString(); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  child.on("error", error => { launchError = error; });
  async function stop() {
    if (launchError || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await closed; } finally { clearTimeout(force); }
  }
  try {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (launchError || child.exitCode !== null) throw new Error(`SSR server failed: ${launchError ?? output}`);
      try {
        const response = await fetch(`${origin}/api/cms/auth/session`, { signal: AbortSignal.timeout(500) });
        await response.arrayBuffer();
        if (response.status === 200) return { origin, stop };
      } catch { /* Poll while the built server starts, independently of its log level. */ }
      await delay(50);
    }
    throw new Error(`SSR server did not become ready: ${output}`);
  } catch (error) { await stop(); throw error; }
}

let server = await start();
try {
  const request = (path, options = {}) => fetch(`${server.origin}${path}`, {
    ...options, signal: AbortSignal.timeout(15_000),
  });
  async function publicPage(title) {
    const response = await request("/");
    assert.equal(response.status, 200, await response.clone().text());
    const html = await response.text();
    assert.match(html, new RegExp(`<h1\\b[^>]*>${title}`));
    assert.match(html, new RegExp(`<p\\b[^>]*\\bid="live-title"[^>]*>${title}`));
  }
  await publicPage("Consumer approved title");
  const session = await request("/api/cms/auth/session");
  assert.equal(session.status, 200);
  assert.match(session.headers.get("cache-control"), /private.*no-store/);
  await session.text();
  const login = await request("/api/cms/auth/login", {
    method: "POST", headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ password: "consumer-fixture" }),
  });
  assert.equal(login.status, 200, await login.text());
  assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
  const headers = { cookie: `${login.headers.get("set-cookie").split(";")[0]}; caret_preview=1`,
    "content-type": "application/json", "x-caret-request": "1", origin: server.origin };
  const read = await request("/api/cms/entries?collection=pages&id=home", { headers });
  assert.equal(read.status, 200);
  const initial = (await read.json()).entries[0];
  assert.equal(initial.data.title, "Consumer approved title");
  const save = data => request("/api/cms/mutate", { method: "POST", headers,
    body: JSON.stringify({ type: "put_entry", collection: "pages", id: "home", data,
      expectedRevision: initial.revision, expectedBaseRevision: initial.baseRevision }) });
  const invalid = await save({ title: 42 });
  assert.equal(invalid.status, 400, await invalid.text());
  const saved = await save({ title: "SSR approved title" });
  assert.equal(saved.status, 200, await saved.text());
  const stale = await save({ title: "Stale SSR title" });
  assert.equal(stale.status, 409, await stale.text());
  // Private drafts must not leak into anonymous rendering or public live loads.
  await publicPage("Consumer approved title");
  const preview = await request("/", { headers });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("cache-control"), /private.*no-store/);
  assert.match(await preview.text(), /<h1\b[^>]*>SSR approved title/);
  const published = await request("/api/cms/publish", { method: "POST", headers,
    body: JSON.stringify({ collection: "pages", id: "home" }) });
  assert.equal(published.status, 200);
  const result = await published.json();
  assert.equal(result.published.length, 1);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.failed, []);
  assert.equal(JSON.parse(await readFile("data/pages/home.json", "utf8")).title, "SSR approved title");
  await publicPage("SSR approved title");
  for (const asset of ["editor.js", "editor.css", "studio/history-client.js"]) {
    const response = await request(`/__caret/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 20, asset);
  }
  await server.stop();
  server = await start();
  await publicPage("SSR approved title");
} finally { await server.stop(); }
console.log("Packed consumer production SSR passed: live loader, private drafts, validation, stale saves, publish, shipped assets, and process restart without rebuilding");
