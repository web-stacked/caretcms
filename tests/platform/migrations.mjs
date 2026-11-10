import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const frozen = join(repo, "tests/fixtures/upgrade/cloudflare-v0.5.0");
const manifest = JSON.parse(await readFile(join(frozen, "manifest.json"), "utf8"));
assert.equal(manifest.commit, "1191d9f19f96d3aec856412b1a0799ff3d9ff357");
for (const [path, hash] of Object.entries(manifest.sha256)) {
  assert.equal(createHash("sha256").update(await readFile(join(frozen, path))).digest("hex"), hash,
    `Frozen released source changed: ${path}`);
}
const require = createRequire(import.meta.url);
const wrangler = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare");
const { build } = wrangler("esbuild");
const scripts = {};
const bundled = { "/.caret/data/deleted/seed.json": { title: "Bundled seed" } };
for (const variant of ["released", "current", "mixed"]) {
  const adapterRoot = variant === "released" ? join(frozen, "packages/cloudflare/src") : join(repo, "packages/cloudflare/dist");
  const objectRoot = variant === "current" ? join(repo, "packages/cloudflare/dist") : join(frozen, "packages/cloudflare/src");
  const aliases = {
    "test:kv-adapter": join(adapterRoot, "adapters/kv-storage." + (variant === "released" ? "ts" : "js")),
    "test:durable-adapter": join(adapterRoot, "adapters/durable-storage." + (variant === "released" ? "ts" : "js")),
    "test:durable-object": join(objectRoot, "durable-object." + (variant === "current" ? "js" : "ts")),
  };
  const compiled = await build({
    entryPoints: [join(repo, "tests/platform/fixtures/upgrade-worker.ts")],
    bundle: true, write: false, format: "esm", platform: "neutral", target: "esnext",
    external: ["cloudflare:workers", "node:*"], conditions: ["import"], logLevel: "silent",
    // Supply identical build-bundled content to historical/current adapters.
    // Storage implementation files themselves remain byte-identical fixtures.
    define: { "import.meta.glob": "__caretUpgradeGlob" },
    banner: { js: `const __caretUpgradeGlob = () => (${JSON.stringify(bundled)});` },
    plugins: [{ name: "upgrade-versions", setup(builder) {
      builder.onResolve({ filter: /^test:/ }, args => ({ path: aliases[args.path] }));
      if (variant === "released") builder.onResolve({ filter: /^@caretcms\/core\/contracts$/ }, () => ({
        // The released KV implementation imports only this contract's ID
        // exports. Resolve them to their exact released implementation.
        path: join(frozen, "packages/core/src/runtime/storage/id-contracts.ts"),
      }));
    } }],
  });
  scripts[variant] = compiled.outputFiles[0].text;
}

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "caret-platform-upgrade-"));
  let runtime;
  t.after(async () => { try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  const switchTo = async variant => {
    await runtime?.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions({
      name: "caret-storage-upgrade", modules: true, script: scripts[variant],
      compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_compat"], cf: false,
      host: "127.0.0.1", port: 0, resourcePersistencePath: root,
      durableObjects: { CMS_CONTENT: { className: "CaretCmsContent", useSQLite: true } },
      kvNamespaces: ["CMS_KV"],
    }));
    await runtime.ready;
  };
  const request = (method, args = [], extra = {}, path = "/invoke") => runtime.dispatchFetch(`https://upgrade.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, instance: "production", method, args, ...extra }),
  });
  const call = async (method, args = [], extra = {}) => {
    const response = await request(method, args, extra);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const result = JSON.parse(text);
    return result.value;
  };
  const snapshot = async (collection, id, extra = {}) => provider === "durable"
    ? call("getEntrySnapshot", [collection, id], extra)
    : { entry: await call("getEntry", [collection, id], extra), revision: await call("getRevision", [collection, id], extra) };
  const publish = async extra => {
    const response = await request("publish", [], { editor: "alice", ...extra }, "/publish");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  await switchTo("released");
  return { switchTo, call, request, snapshot, publish, namespace: () => runtime.getKVNamespace("CMS_KV") };
}
const metadata = { id: "posts", label: "Posts", created_at: 1, updated_at: 1,
  schema: { type: "object", properties: { title: { type: "string" } } } };
const receipt = { published: [{ collection: "posts", id: "one", revision: 4, deleted: false }], commit: null };
const target = { ...receipt, id: "released-deployment", requestedAt: 1700000000000 };
const history = { ts: 1, action: "put", data: null };

for (const provider of ["kv", "durable"]) {
  test(`${provider}: v0.5.0 base, private drafts, receipts, and sessions survive a code upgrade and restart`, async t => {
    const { call, snapshot, publish, switchTo } = await fixture(t, provider);
    await call("createCollection", [metadata]);
    await call("writeEntry", ["posts", "one", { title: "Released content" }]);
    for (let n = 0; n < 4; n++) await call("bumpRevision", ["posts", "one"]);
    await call("appendHistory", ["posts", "one", history]);
    await call("writeEntry", ["posts", "removed", { title: "Remove me" }]);
    await call("bumpRevision", ["posts", "removed"]);
    await call("deleteEntry", ["posts", "removed"]);
    const alice = { editor: "alice" }, visitor = { session: "visitor" };
    await call("createCollection", [metadata], alice);
    await call("writeEntry", ["posts", "one", { title: "Released private draft" }], alice);
    await call("bumpRevision", ["posts", "one"], alice);
    await call("appendHistory", ["posts", "one", history], alice);
    await call("setRebuildReceipt", [receipt], alice);
    await call("setDeploymentTarget", [target], alice);
    await call("writeEntry", ["posts", "one", { title: "Released session" }], visitor);
    for (const restart of [1, 2]) {
      await switchTo("current");
      assert.deepEqual(await snapshot("posts", "one"), { entry: { id: "one", data: { title: "Released content" } }, revision: 4 });
      assert.deepEqual(await call("getHistory", ["posts", "one"]), [history]);
      assert.deepEqual(await call("getCollectionMetadata", ["posts"]), metadata);
      assert.deepEqual(await call("listEntryIds", ["posts"]), ["one"]);
      assert.equal(await call("getEntry", ["posts", "removed"]), null);
      assert.equal(await call("getRevision", ["posts", "removed"]), 1);
      assert.deepEqual(await snapshot("posts", "one", alice), { entry: { id: "one", data: { title: "Released private draft" } }, revision: 1 });
      assert.deepEqual(await call("getHistory", ["posts", "one"], alice), [history]);
      assert.deepEqual(await call("getCollectionMetadata", ["posts"], alice), metadata);
      assert.deepEqual(await call("getRebuildReceipt", [], alice), receipt);
      assert.deepEqual(await call("getDeploymentTarget", [], alice), target);
      assert.equal(await call("getRebuildReceipt"), null);
      assert.equal(await call("getEntry", ["posts", "one"], { editor: "bob" }), null);
      assert.equal((await call("getEntry", ["posts", "one"], visitor)).data.title, "Released session");
      assert.equal(await call("getEntry", ["posts", "one"], { session: "other" }), null);
    }
    const legacy = await publish();
    assert.deepEqual(legacy.published, []);
    assert.deepEqual(legacy.failed, []);
    assert.deepEqual(legacy.conflicts, [{ collection: "posts", id: "one", reason: "legacy_draft" }]);
    assert.equal((await call("getEntry", ["posts", "one"], alice)).data.title, "Released private draft");
    assert.equal((await call("getEntry", ["posts", "one"])).data.title, "Released content");
    assert.equal(await call("getRevision", ["posts", "one"]), 4);
  });

  test(`${provider}: frozen v1 publication plans resume at all four bookkeeping boundaries after upgrading`, async t => {
    const { call, switchTo, publish } = await fixture(t, provider);
    const plans = {};
    for (const id of ["before-write", "after-data", "after-revision", "after-history"]) {
      const store = join(repo, "tests/fixtures/upgrade/pre-hardening-store");
      const draft = JSON.parse(await readFile(join(store, "drafts/alice/data/pages", `${id}.json`), "utf8"));
      const data = JSON.parse(await readFile(join(store, "data/pages", `${id}.json`), "utf8"));
      plans[id] = draft.__caret_publish__;
      await call("writeEntry", ["pages", id, data]);
      for (let n = 0; n < (id === "after-revision" || id === "after-history" ? 8 : 7); n++) await call("bumpRevision", ["pages", id]);
      if (id === "after-history") await call("appendHistory", ["pages", id, plans[id].history]);
      await call("writeEntry", ["pages", id, draft], { editor: "alice" });
      for (let n = 0; n < 3; n++) await call("bumpRevision", ["pages", id], { editor: "alice" });
    }
    await call("setRebuildReceipt", [receipt], { editor: "alice" });
    await switchTo("current");
    const result = await publish();
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.published.length, 4);
    for (const entry of result.published) assert.equal(entry.revision, 8);
    await switchTo("current");
    for (const [id, plan] of Object.entries(plans)) {
      assert.deepEqual((await call("getEntry", ["pages", id])).data, plan.afterData);
      assert.equal(await call("getRevision", ["pages", id]), 8);
      assert.deepEqual(await call("getHistory", ["pages", id]), [plan.history]);
      assert.equal(await call("getEntry", ["pages", id], { editor: "alice" }), null);
    }
    assert.deepEqual((await publish()).published, []);
    assert.deepEqual(await call("getRebuildReceipt", [], { editor: "alice" }), receipt);
  });
}

test("KV: old prefixed-site private data stays unassigned instead of being silently attributed to a tenant", async t => {
  const { call, switchTo, namespace } = await fixture(t, "kv");
  const a = { prefix: "tenant-a:" }, b = { prefix: "tenant-b:" };
  await call("writeEntry", ["posts", "one", { title: "Base A" }], a);
  await call("writeEntry", ["posts", "one", { title: "Base B" }], b);
  await call("writeEntry", ["posts", "one", { title: "Ambiguous old private data" }], { ...a, editor: "alice" });
  assert.equal((await call("getEntry", ["posts", "one"], { ...b, editor: "alice" })).data.title, "Ambiguous old private data");
  const before = await (await namespace()).get("draft/alice/posts::one", "json");
  assert.ok(before);
  await switchTo("current");
  assert.equal(await call("getEntry", ["posts", "one"], { ...a, editor: "alice" }), null);
  assert.equal(await call("getEntry", ["posts", "one"], { ...b, editor: "alice" }), null);
  assert.equal((await call("getEntry", ["posts", "one"], { editor: "alice" })).data.title, "Ambiguous old private data");
  await call("writeEntry", ["posts", "one", { title: "New private A" }], { ...a, editor: "alice" });
  assert.equal(await call("getEntry", ["posts", "one"], { ...b, editor: "alice" }), null);
  assert.deepEqual(await (await namespace()).get("draft/alice/posts::one", "json"), before);
  assert.equal((await call("getEntry", ["posts", "one"], a)).data.title, "Base A");
  assert.equal((await call("getEntry", ["posts", "one"], b)).data.title, "Base B");
});

test("Durable Object: mixed class deployment fails closed, and coordinated mode does not consume old separate drafts", async t => {
  const { call, request, switchTo } = await fixture(t, "durable");
  await call("writeEntry", ["posts", "one", { title: "Base" }]);
  await call("writeEntry", ["posts", "one", { title: "Old separate draft" }], { editor: "alice" });
  await call("setRebuildReceipt", [receipt], { editor: "alice" });
  await switchTo("mixed");
  const attempted = await request("writeEntry", ["posts", "one", { title: "Must never become base" }], { editor: "alice", coordinated: true });
  assert.equal(attempted.status, 500);
  assert.equal((await call("getEntry", ["posts", "one"])).data.title, "Base");
  await switchTo("current");
  assert.equal((await call("getEntry", ["posts", "one"], { editor: "alice" })).data.title, "Old separate draft");
  assert.deepEqual(await call("getRebuildReceipt", [], { editor: "alice" }), receipt);
  assert.equal(await call("getEntry", ["posts", "one"], { editor: "alice", coordinated: true }), null);
  await call("writeEntry", ["posts", "one", { title: "New coordinated draft" }], { editor: "alice", coordinated: true });
  assert.equal((await call("getEntry", ["posts", "one"])).data.title, "Base");
  assert.equal((await call("getEntry", ["posts", "one"], { editor: "alice" })).data.title, "Old separate draft");
  await switchTo("current");
  assert.equal((await call("getEntry", ["posts", "one"], { editor: "alice", coordinated: true })).data.title, "New coordinated draft");
});

for (const provider of ["kv", "durable"]) {
  test(`${provider}: historical collection deletion preserves only intent that the old release recorded`, async t => {
    const { call, switchTo } = await fixture(t, provider);
    const seeded = { bundled: true };
    assert.equal((await call("getEntry", ["deleted", "seed"], seeded)).data.title, "Bundled seed");
    await call("writeEntry", ["deleted", "runtime", { title: "Runtime content" }]);
    await call("bumpRevision", ["deleted", "runtime"]);
    await call("deleteCollection", ["deleted"]);
    await switchTo("current");
    // v0.5.0 discarded numeric versions for collection-deleted entries. There
    // is no persisted value from which an upgrade can recover the old token.
    assert.equal(await call("getRevision", ["deleted", "runtime"]), 0);
    if (provider === "kv") {
      // Old KV had no collection deletion marker: bundled fallback cannot
      // know the original intent. Replay the intended deletion after review.
      assert.equal((await call("getEntry", ["deleted", "seed"], seeded)).data.title, "Bundled seed");
      await call("deleteCollection", ["deleted"], seeded);
    } else {
      assert.equal(await call("getEntry", ["deleted", "seed"], seeded), null);
    }
    await call("createCollection", [{ ...metadata, id: "deleted" }], seeded);
    assert.equal(await call("getEntry", ["deleted", "seed"], seeded), null);
    await switchTo("current");
    assert.equal(await call("getEntry", ["deleted", "seed"], seeded), null);
  });
}
