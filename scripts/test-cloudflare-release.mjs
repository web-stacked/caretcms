// Actual Astro SSR bundles, restarted against one local workerd persistence
// directory. No remote deployment, account selection, or resource creation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "tests/fixtures/cloudflare-release");
const scratch = await mkdtemp(join(tmpdir(), "caret-release-ssr-"));
const secret = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("hex");
const listen = createServer();
await new Promise(done => listen.listen(0, "127.0.0.1", done));
const port = listen.address().port;
await new Promise(done => listen.close(done));
const origin = `http://127.0.0.1:${port}`;
let worker;
const results = [];
const log = message => { results.push(message); console.log(message); };

async function command(binary, args, env = {}) {
  const child = spawn(binary, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  assert.equal(code, 0, output);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise(done => worker.once("exit", done));
  worker.kill("SIGTERM");
  const timeout = setTimeout(() => worker.kill("SIGKILL"), 10_000);
  try { await exited; } finally { clearTimeout(timeout); }
}
async function request(path, body, cookie) {
  return fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", origin,
      "x-caret-request": "1", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
}
async function json(path, body, cookie) {
  const response = await request(path, body, cookie);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
const storage = async (method, args = [], extra = {}) => (await json("/__gate/storage",
  { provider: "durable", instance: "recovery", method, args, ...extra })).value;
async function start(stage, marker) {
  await stop();
  const original = join(fixture, `dist/${stage}/server/wrangler.json`);
  const config = JSON.parse(await readFile(original, "utf8"));
  config.main = resolve(dirname(original), config.main);
  config.assets.directory = resolve(dirname(original), config.assets.directory);
  config.vars.CARET_GATE_BUILD = marker;
  delete config.configPath;
  delete config.userConfigPath;
  const configFile = join(scratch, "wrangler.json");
  await writeFile(configFile, JSON.stringify(config));
  worker = spawn(join(root, "node_modules/.bin/wrangler"), ["dev", "--local", "--config", configFile,
    "--persist-to", join(scratch, "persist"), "--ip", "127.0.0.1", "--port", String(port)],
  { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [worker.stdout, worker.stderr]) stream.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(worker.exitCode, null, output);
    try { if ((await json("/__gate/info")).build === marker) return; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error(`Local Worker startup timed out: ${output}`);
}

try {
  const frozen = join(root, "tests/fixtures/upgrade/cloudflare-v0.5.0");
  const manifest = JSON.parse(await readFile(join(frozen, "manifest.json"), "utf8"));
  assert.equal(manifest.commit, "1191d9f19f96d3aec856412b1a0799ff3d9ff357");
  for (const [file, hash] of Object.entries(manifest.sha256)) {
    assert.equal(createHash("sha256").update(await readFile(join(frozen, file))).digest("hex"), hash, file);
  }
  await writeFile(join(scratch, ".dev.vars"), `CARET_GATE_TOKEN=${secret}\nCARET_EDIT_PASSWORD=${password}\nCARET_SESSION_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  await command(join(root, "node_modules/.bin/astro"), ["build", "--root", fixture], { CARET_GATE_STAGE: "released" });
  await command(join(root, "node_modules/.bin/astro"), ["build", "--root", fixture], { CARET_GATE_STAGE: "current" });
  for (const stage of ["released", "current"]) {
    await command(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--config",
      join(fixture, `dist/${stage}/server/wrangler.json`), "--outdir", join(scratch, `dry-run-${stage}`)],
    { WRANGLER_SEND_METRICS: "false" });
  }
  log("Both compiled Astro Worker artifacts pass Wrangler deployment dry-run checks without uploading.");
  await start("released", "released");
  assert.equal((await fetch(origin)).status, 403);
  assert.equal((await fetch(`${origin}/__caret/editor.js`)).status, 403);
  assert.match(await (await request("/")).text(), /Release seed/);
  const plans = {};
  for (const id of ["before-write", "after-data", "after-revision", "after-history"]) {
    const store = join(root, "tests/fixtures/upgrade/pre-hardening-store");
    const draft = JSON.parse(await readFile(join(store, "drafts/alice/data/pages", `${id}.json`), "utf8"));
    plans[id] = draft.__caret_publish__;
    await storage("writeEntry", ["pages", id, JSON.parse(await readFile(join(store, "data/pages", `${id}.json`), "utf8"))]);
    for (let n = 0; n < (["after-revision", "after-history"].includes(id) ? 8 : 7); n++) await storage("bumpRevision", ["pages", id]);
    if (id === "after-history") await storage("appendHistory", ["pages", id, plans[id].history]);
    await storage("writeEntry", ["pages", id, draft], { editor: "alice" });
    for (let n = 0; n < 3; n++) await storage("bumpRevision", ["pages", id], { editor: "alice" });
  }
  log("Released Astro Worker seeded four frozen publication recovery plans.");
  await start("current", "current-1");
  const published = await json("/__gate/publish", { provider: "durable", instance: "recovery", editor: "alice" });
  assert.deepEqual(published.failed, []);
  assert.deepEqual(published.conflicts, []);
  assert.equal(published.published.length, 4);
  const login = await request("/api/cms/auth/login", { password });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const change = title => ({ type: "put_entry", collection: "pages", id: "home", data: { title }, expectedRevision: 0 });
  const raced = await Promise.all([request("/api/cms/mutate", change("Writer A"), cookie), request("/api/cms/mutate", change("Writer B"), cookie)]);
  assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
  const entry = (await json("/api/cms/entries?collection=pages&id=home", undefined, cookie)).entries[0];
  assert.equal(entry.revision, 1);
  const html = await (await request("/")).text();
  assert.ok(html.includes(entry.data.title));
  log("Current Astro SSR and CMS login work; concurrent HTTP writes yield one success and one conflict.");
  const secondLogin = await request("/api/cms/auth/login", { password });
  assert.equal(secondLogin.status, 200);
  const secondCookie = secondLogin.headers.get("set-cookie").split(";")[0];
  const preview = [cookie, secondCookie].map(value => `${value}; caret_preview=1`);
  const titles = ["Alice private draft", "Bob private draft"];
  assert.deepEqual(await json("/context.json", undefined, preview[0]), { previewCookie: "1", editor: true, overlayActive: true });
  const invalid = await request("/api/cms/mutate", { ...change(42), expectedBaseRevision: 1 }, preview[0]);
  assert.equal(invalid.status, 400, await invalid.text());
  for (let n = 0; n < 2; n++) {
    await json("/api/cms/mutate", { ...change(titles[n]), expectedBaseRevision: 1 }, preview[n]);
    const response = await request("/", undefined, preview[n]);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const privateHtml = await response.text();
    assert.ok(privateHtml.includes(titles[n]));
    assert.ok(!privateHtml.includes(titles[1 - n]));
  }
  assert.ok((await (await request("/")).text()).includes(entry.data.title));
  assert.equal((await request("/__caret/editor.js", undefined, cookie)).status, 200);
  const publications = await Promise.all(preview.map(value => json("/api/cms/publish", { collection: "pages", id: "home" }, value)));
  assert.equal(publications.flatMap(result => result.published).length, 1);
  assert.equal(publications.flatMap(result => result.conflicts).length, 1);
  assert.deepEqual(publications.flatMap(result => result.failed), []);
  const winner = publications.findIndex(result => result.published.length === 1);
  const finalEntry = (await json("/api/cms/entries?collection=pages&id=home", undefined, cookie)).entries[0];
  assert.equal(finalEntry.revision, 2);
  assert.equal(finalEntry.data.title, titles[winner]);
  log("Private SSR previews stay isolated; schema rejection and simultaneous CMS publishes preserve the losing draft.");
  await start("current", "current-2");
  for (const [id, plan] of Object.entries(plans)) {
    assert.deepEqual((await storage("getEntry", ["pages", id])).data, plan.afterData);
    assert.equal(await storage("getRevision", ["pages", id]), 8);
    assert.deepEqual(await storage("getHistory", ["pages", id]), [plan.history]);
    assert.equal(await storage("getEntry", ["pages", id], { editor: "alice" }), null);
  }
  assert.deepEqual((await json("/__gate/publish", { provider: "durable", instance: "recovery", editor: "alice" })).published, []);
  assert.deepEqual((await json("/api/cms/entries?collection=pages&id=home", undefined, cookie)).entries[0], finalEntry);
  assert.equal((await json("/api/cms/entries?collection=pages&id=home", undefined, preview[1 - winner])).entries[0].data.title, titles[1 - winner]);
  assert.equal((await storage("getHistory", ["pages", "home"], { instance: "primary" })).length, 2);
  log("Restart preserves content, cookies, revisions, and exactly one history record per recovered publish.");
  await storage("writeEntry", ["scratch", "one", { title: "Expires" }], { instance: "expiry", ttl: 2 });
  const inspect = () => json("/__gate/inspect", { provider: "durable", instance: "expiry" });
  const initial = await inspect();
  assert.ok(initial.keys.length > 0);
  assert.equal(typeof initial.alarm, "number");
  const deadline = Date.now() + 30_000;
  while ((await inspect()).keys.length > 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 250));
  assert.deepEqual((await inspect()).keys, []);
  assert.equal(await storage("getEntry", ["scratch", "one"], { instance: "expiry" }), null);
  log("Native Durable Object alarm expiry clears the separate temporary instance.");
} finally {
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
