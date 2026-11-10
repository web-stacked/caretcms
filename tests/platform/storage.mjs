import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Use the compiler/runtime shipped with the example's exact-pinned Wrangler.
// Resolving from Wrangler also works when npm nests these dependencies.
const require = createRequire(import.meta.url);
const wrangler = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare");
const { build } = wrangler("esbuild");
const root = await mkdtemp(join(tmpdir(), "caret-platform-"));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("fixtures/storage-worker.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "neutral", target: "esnext",
  external: ["cloudflare:workers", "node:*"], conditions: ["import"], logLevel: "silent",
});
const options = {
  name: "caret-storage-test", modules: true, script: compiled.outputFiles[0].text,
  compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_compat"], cf: false,
  host: "127.0.0.1", port: 0,
  durableObjects: { CMS_CONTENT: { className: "TestCaretCmsContent", useSQLite: true } },
  kvNamespaces: ["CMS_KV"],
  resourcePersistencePath: root,
};
const nativeOptions = convertV4MiniflareOptions(options);
let runtime = new Miniflare(nativeOptions);
after(async () => { try { await runtime.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
async function request(path, body) {
  return runtime.dispatchFetch(`https://storage.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function invoke(provider, instance, method, args = [], extra = {}) {
  const response = await request("/invoke", { provider, instance, method, args, ...extra });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.value;
}
const metadata = { id: "posts", label: "Posts", created_at: 1, updated_at: 1,
  schema: { type: "object", properties: { title: { type: "string" } } } };
const change = (id, title, revision = 0) => ({ collection: "posts", id, expectedRevision: revision,
  expectedExists: revision > 0, data: { title }, history: { ts: revision + 1, action: "put", data: null } });

for (const provider of ["durable", "kv"]) {
  test(`${provider}: public conformance against native local storage`, async () => {
    const response = await request("/conformance", { provider, instance: `conformance-${provider}` });
    assert.equal(response.status, 200);
    const results = await response.json();
    assert.equal(results.length, 14);
    assert.deepEqual(results.filter(result => result.status === "failed"), []);
    assert.ok(results.some(result => result.status === "passed"));
    console.log(`${provider} conformance: ${results.filter(r => r.status === "passed").length} passed, ${results.filter(r => r.status === "skipped").length} explicitly skipped`);
  });
}

test("both adapters retain content, versions, history, drafts, receipts, and deletions across a runtime restart", async () => {
  for (const provider of ["durable", "kv"]) {
    const call = (method, args, extra) => invoke(provider, "restart", method, args, extra);
    await call("createCollection", [metadata]);
    await call("writeEntry", ["posts", "one", { title: "Persistent" }]);
    await call("bumpRevision", ["posts", "one"]);
    await call("appendHistory", ["posts", "one", { ts: 1, action: "put", data: null }]);
    await call("writeEntry", ["removed", "old", { title: "Removed" }]);
    await call("bumpRevision", ["removed", "old"]);
    await call("deleteCollection", ["removed"]);
    await call("writeEntry", ["posts", "one", { title: "Alice draft" }], { editor: "alice" });
    await call("setRebuildReceipt", [{ published: [{ collection: "posts", id: "one", revision: 1, deleted: false }], commit: null }]);
  }
  const oldInstance = await (await request("/inspect", { instance: "restart" })).json();
  await runtime.dispose();
  runtime = new Miniflare(nativeOptions);
  const newInstance = await (await request("/inspect", { instance: "restart" })).json();
  assert.notEqual(oldInstance.instanceToken, newInstance.instanceToken, "Worker must actually restart");
  for (const provider of ["durable", "kv"]) {
    const call = (method, args, extra) => invoke(provider, "restart", method, args, extra);
    assert.deepEqual(await call("getEntry", ["posts", "one"]), { id: "one", data: { title: "Persistent" } });
    assert.equal(await call("getRevision", ["posts", "one"]), 1);
    assert.deepEqual(await call("getHistory", ["posts", "one"]), [{ ts: 1, action: "put", data: null }]);
    assert.deepEqual(await call("getCollectionMetadata", ["posts"]), metadata);
    assert.deepEqual(await call("listEntryIds", ["posts"]), ["one"]);
    assert.deepEqual(await call("discoverCollections"), ["posts"]);
    assert.equal(await call("getEntry", ["removed", "old"]), null);
    assert.equal(await call("getRevision", ["removed", "old"]), 2);
    assert.deepEqual(await call("getEntry", ["posts", "one"], { editor: "alice" }), { id: "one", data: { title: "Alice draft" } });
    assert.equal(await call("getEntry", ["posts", "one"], { editor: "bob" }), null);
    assert.deepEqual((await call("getRebuildReceipt")).published, [{ collection: "posts", id: "one", revision: 1, deleted: false }]);
  }
});

test("Durable Object rolls back actual writes on an injected mid-transaction failure", async () => {
  await request("/arm", { instance: "rollback", fault: "rollback" });
  const failed = await request("/invoke", { provider: "durable", instance: "rollback", method: "commitEntries",
    args: [[change("a", "A"), change("b", "B")]] });
  assert.equal(failed.status, 500);
  assert.equal((await (await request("/inspect", { instance: "rollback" })).json()).failureWrites, 8);
  for (const id of ["a", "b"]) {
    assert.deepEqual(await invoke("durable", "rollback", "getEntrySnapshot", ["posts", id]), { entry: null, revision: 0 });
    assert.deepEqual(await invoke("durable", "rollback", "getHistory", ["posts", id]), []);
  }
  assert.deepEqual(await invoke("durable", "rollback", "listEntryIds", ["posts"]), []);
  assert.deepEqual(await invoke("durable", "rollback", "discoverCollections"), []);
  assert.equal((await invoke("durable", "rollback", "commitEntries", [[change("a", "A"), change("b", "B")]])).ok, true);
});

test("lost Durable Object acknowledgement leaves one commit and rejects a stale retry", async () => {
  await request("/arm", { instance: "lost-ack", fault: "lost-ack" });
  const changes = [change("one", "Approved")];
  const response = await request("/invoke", { provider: "durable", instance: "lost-ack", method: "commitEntries", args: [changes] });
  assert.equal(response.status, 500);
  assert.deepEqual(await invoke("durable", "lost-ack", "getEntrySnapshot", ["posts", "one"]),
    { entry: { id: "one", data: { title: "Approved" } }, revision: 1 });
  assert.deepEqual(await invoke("durable", "lost-ack", "commitEntries", [changes]),
    { ok: false, conflict: { collection: "posts", id: "one", currentRevision: 1, exists: true } });
  assert.equal((await invoke("durable", "lost-ack", "getHistory", ["posts", "one"])).length, 1);
});

for (const kind of ["editor", "session"]) {
  test(`KV ${kind} overlays remain isolated between parent site prefixes`, async () => {
    const extra = { [kind]: "shared-identity" };
    await invoke("kv", `tenant-a-${kind}`, "writeEntry", ["posts", "one", { title: "Private A" }], extra);
    await invoke("kv", `tenant-a-${kind}`, "bumpRevision", ["posts", "one"], extra);
    assert.equal(await invoke("kv", `tenant-b-${kind}`, "getEntry", ["posts", "one"], extra), null);
    assert.equal(await invoke("kv", `tenant-b-${kind}`, "getRevision", ["posts", "one"], extra), 0);
    assert.deepEqual(await invoke("kv", `tenant-b-${kind}`, "listEntryIds", ["posts"] , extra), []);
    assert.equal((await invoke("kv", `tenant-a-${kind}`, "getEntry", ["posts", "one"], extra)).data.title, "Private A");
  });
}

test("Durable Object session alarms refresh and clear all session state after restart", { timeout: 20_000 }, async () => {
  const call = (method, args) => invoke("durable", "expiry", method, args, { ttl: 2 });
  await call("createCollection", [metadata]);
  await call("commitEntries", [[change("one", "Temporary")]]);
  await call("setRebuildReceipt", [{ published: [], commit: null }]);
  const first = await (await request("/inspect", { instance: "expiry" })).json();
  assert.ok(first.alarm > Date.now());
  await delay(100);
  await call("getEntry", ["posts", "one"]);
  const refreshed = await (await request("/inspect", { instance: "expiry" })).json();
  assert.ok(refreshed.alarm > first.alarm);
  await runtime.dispose();
  runtime = new Miniflare(nativeOptions);
  const deadline = Date.now() + 10_000;
  let state;
  do {
    await delay(100);
    state = await (await request("/inspect", { instance: "expiry" })).json();
  } while (state.keys.length && Date.now() < deadline);
  assert.deepEqual(state.keys, [], "Expiry must clear content, revisions, history, indexes, metadata, and receipts");
  assert.equal(await invoke("durable", "expiry", "getEntry", ["posts", "one"]), null);
});

test("KV session writes carry platform expiry and native KV rejects TTL below its minimum", async () => {
  await invoke("kv", "session-expiry", "writeEntry", ["posts", "one", { title: "Session" }], { session: "visitor" });
  const namespace = await runtime.getKVNamespace("CMS_KV");
  const listing = await namespace.list({ prefix: "session-expiry:session/visitor/" });
  assert.ok(listing.keys.length > 0);
  for (const key of listing.keys) assert.ok(key.expiration >= Math.floor(Date.now() / 1000) + 7_190);
  const response = await request("/invoke", { provider: "kv", instance: "invalid-ttl", ttl: 1,
    method: "writeEntry", args: ["posts", "one", { title: "Invalid" }] });
  assert.equal(response.status, 500);
});

const coordinated = { coordinated: true, editor: "alice", view: true };
const draftChange = (id, title, revision = 0) => ({ ...change(id, title, revision),
  expectedExists: true, expectedBaseRevision: 1, requireBaseRevision: true });

test("coordinated drafts reject a cross-client base race with no partial batch writes", async () => {
  const instance = "coordinated-race";
  await invoke("durable", instance, "commitEntries", [[change("a", "Base A"), change("b", "Base B")]]);
  const result = await invoke("durable", instance, "commitEntries", [[draftChange("a", "Draft A"), draftChange("b", "Draft B")]],
    { ...coordinated, raceChanges: [change("b", "Other writer", 1)] });
  assert.deepEqual(result, { ok: false, conflict: { collection: "posts", id: "b", currentRevision: 0,
    currentBaseRevision: 2, exists: false } });
  for (const id of ["a", "b"]) {
    assert.equal(await invoke("durable", instance, "getEntry", ["posts", id], { ...coordinated, view: false }), null);
    assert.equal(await invoke("durable", instance, "getRevision", ["posts", id], coordinated), 0);
    assert.deepEqual(await invoke("durable", instance, "getHistory", ["posts", id], coordinated), []);
  }
  assert.equal((await invoke("durable", instance, "getEntry", ["posts", "b"])).data.title, "Other writer");
});

test("coordinated native transactions roll back persisted private writes and reject stale retries after a lost acknowledgement", async () => {
  const instance = "coordinated-faults";
  await invoke("durable", instance, "commitEntries", [[change("a", "Base A"), change("b", "Base B")]]);
  const changes = [draftChange("a", "Draft A"), draftChange("b", "Draft B")];
  await request("/arm", { instance, fault: "rollback" });
  const failed = await request("/invoke", { provider: "durable", instance, method: "commitEntries", args: [changes], ...coordinated });
  assert.equal(failed.status, 500);
  assert.equal((await (await request("/inspect", { instance })).json()).failureWrites, 8);
  for (const id of ["a", "b"]) {
    assert.equal(await invoke("durable", instance, "getEntry", ["posts", id], { ...coordinated, view: false }), null);
    assert.equal(await invoke("durable", instance, "getRevision", ["posts", id], coordinated), 0);
  }
  await request("/arm", { instance, fault: "lost-ack" });
  const lost = await request("/invoke", { provider: "durable", instance, method: "commitEntries", args: [changes], ...coordinated });
  assert.equal(lost.status, 500);
  assert.deepEqual(await invoke("durable", instance, "commitEntries", [changes], coordinated),
    { ok: false, conflict: { collection: "posts", id: "a", currentRevision: 1, exists: true } });
  for (const id of ["a", "b"]) {
    assert.equal(await invoke("durable", instance, "getRevision", ["posts", id], coordinated), 1);
    assert.equal((await invoke("durable", instance, "getHistory", ["posts", id], coordinated)).length, 1);
    assert.equal((await invoke("durable", instance, "getEntry", ["posts", id])).data.title, `Base ${id.toUpperCase()}`);
  }
});

test("colocated draft realms survive restart and never expose private data through base, other editors, or sessions", async () => {
  const instance = "coordinated-restart";
  await invoke("durable", instance, "commitEntries", [[change("one", "Published")]]);
  await invoke("durable", instance, "commitEntries", [[draftChange("one", "Private Alice")]], coordinated);
  await invoke("durable", instance, "setRebuildReceipt", [{ published: [], commit: null }], coordinated);
  const before = await (await request("/inspect", { instance })).json();
  assert.equal(before.alarm, null);
  assert.ok(before.keys.includes("~draft::alice::entry::posts::one"));
  await runtime.dispose();
  runtime = new Miniflare(nativeOptions);
  const after = await (await request("/inspect", { instance })).json();
  assert.notEqual(before.instanceToken, after.instanceToken);
  assert.equal((await invoke("durable", instance, "getEntry", ["posts", "one"], coordinated)).data.title, "Private Alice");
  assert.equal(await invoke("durable", instance, "getRevision", ["posts", "one"], coordinated), 1);
  for (const extra of [{}, { ...coordinated, editor: "bob" }, { coordinated: true, session: "visitor" }]) {
    assert.equal(await invoke("durable", instance, "getRebuildReceipt", [], extra), null);
  }
  assert.equal((await invoke("durable", instance, "getEntry", ["posts", "one"])).data.title, "Published");
  assert.equal((await invoke("durable", instance, "getEntry", ["posts", "one"], { ...coordinated, editor: "bob" })).data.title, "Published");
  assert.equal(await invoke("durable", "other-coordinated-tenant", "getEntry", ["posts", "one"], coordinated), null);
  const snapshots = await invoke("durable", instance, "getEntrySnapshots", ["posts", ["one", "missing", "one"]], coordinated);
  assert.deepEqual(snapshots[0], snapshots[2]);
  assert.equal(snapshots[0].entry.data.title, "Private Alice");
  assert.deepEqual(snapshots[1], { entry: null, revision: 0, baseRevision: 0 });
  assert.equal((await (await request("/inspect", { instance })).json()).alarm, null);
});

test("coordinated native storage passes every applicable public conformance check", async () => {
  const response = await request("/conformance", { provider: "durable", instance: "conformance-coordinated", coordinated: true });
  const results = await response.json();
  assert.equal(response.status, 200);
  assert.equal(results.length, 14);
  assert.equal(results.filter(result => result.status === "passed").length, 13);
  assert.deepEqual(results.filter(result => result.status === "failed"), []);
});

test("a recovery journal added without advancing the draft version cannot be overwritten by a prepared edit", async () => {
  const instance = "coordinated-recovery-race";
  await invoke("durable", instance, "commitEntries", [[change("one", "Published")]]);
  await invoke("durable", instance, "commitEntries", [[draftChange("one", "Approved draft")]], coordinated);
  const result = await invoke("durable", instance, "commitEntries", [[draftChange("one", "Raced edit", 1)]],
    { ...coordinated, raceRecovery: true });
  assert.deepEqual(result, { ok: false, conflict: { collection: "posts", id: "one", currentRevision: 1, exists: true } });
  const raw = await invoke("durable", instance, "getEntry", ["posts", "one"], { ...coordinated, view: false });
  assert.equal(raw.data.title, "Approved draft");
  assert.deepEqual(raw.data.__caret_publish__, { version: 1 });
  assert.equal((await invoke("durable", instance, "getHistory", ["posts", "one"], coordinated)).length, 1);
});
