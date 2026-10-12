import { CloudflareDurableStorageAdapter } from "@caretcms/cloudflare";
export { CaretCmsContent } from "@caretcms/cloudflare/durable-object";

function adapter(instanceName: string): CloudflareDurableStorageAdapter {
  return new CloudflareDurableStorageAdapter({ instanceName, bundledFallback: false });
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CaretCMS Durable Object check</title></head>
<body><button id="run">Run concurrency check</button><pre id="result">idle</pre>
<script type="module">
document.querySelector('#run').addEventListener('click', async () => {
  const run = crypto.randomUUID();
  const get = path => fetch(path + (path.includes('?') ? '&' : '?') + 'run=' + run).then(r => r.json());
  const sameEntry = await Promise.all([get('/same?title=A'), get('/same?title=B')]);
  const distinctEntries = await Promise.all([get('/distinct?id=a'), get('/distinct?id=b')]);
  await get('/advance-b');
  const staleBatch = await get('/stale-batch');
  const retry = await get('/retry');
  const inspected = await get('/inspect');
  const result = { sameEntry, distinctEntries, staleBatch, retry, ...inspected };
  document.querySelector('#result').textContent = JSON.stringify(result);
});
</script></body></html>`;

export default {
  async fetch(request: Request, env: { CMS_CONTENT: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init: RequestInit): Promise<Response> } } }): Promise<Response> {
    const url = new URL(request.url);
    const run = url.searchParams.get("run") ?? crypto.randomUUID();
    const storage = adapter(run);
    if (url.pathname === "/coordinated-draft") {
      const published = new CloudflareDurableStorageAdapter({ instanceName: run, bundledFallback: false, editorDrafts: "coordinated" });
      await published.commitEntries([{ collection: "posts", id: "one", expectedRevision: 0, expectedExists: false, data: { title: "Base" } }]);
      const raw = await published.makeEditorOverlay("alice");
      const coordinator = raw.coordinateDrafts!(published)!;
      const [captured] = await coordinator.getEntrySnapshots("posts", ["one"]);
      await adapter(run).commitEntries([{ collection: "posts", id: "one", expectedRevision: 1, expectedExists: true, data: { title: "Other writer" } }]);
      const changes = [{ collection: "posts", id: "one", expectedRevision: 0, expectedExists: false, data: { title: "Private draft" } }];
      const raced = await coordinator.commitEntries(changes, [{ collection: "posts", id: "one", revision: captured.base.revision }],
        [{ collection: "posts", id: "one", data: captured.overlay.entry?.data ?? null }]);
      const retry = await coordinator.commitEntries(changes, [{ collection: "posts", id: "one", revision: 2 }],
        [{ collection: "posts", id: "one", data: null }]);
      const bob = await published.makeEditorOverlay("bob");
      return Response.json({ raced, retry, published: await published.getEntrySnapshot("posts", "one"),
        private: await raw.getEntrySnapshot!("posts", "one"), otherEditor: await bob.getEntry("posts", "one") });
    }
    if (url.pathname === "/collection-recreate") {
      await storage.commitEntries([{ collection: "removed", id: "one", expectedRevision: 0, expectedExists: false, data: { title: "Original" } }]);
      await storage.deleteCollection("removed");
      const removed = await storage.getEntrySnapshot("removed", "one");
      await storage.createCollection({ id: "removed", label: "Removed", created_at: 1, updated_at: 1,
        schema: { type: "object", properties: {} } });
      const recreated = await storage.commitEntries([{ collection: "removed", id: "one", expectedRevision: 2, expectedExists: false, data: { title: "Recreated" } }]);
      const stale = await storage.commitEntries([{ collection: "removed", id: "one", expectedRevision: 1, expectedExists: true, data: { title: "Stale" } }]);
      const stub = env.CMS_CONTENT.get(env.CMS_CONTENT.idFromName(run));
      const seeded = await stub.fetch("https://caretcms.internal/storage", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "commit_entries", changes: [{ collection: "removed", id: "seed", expectedRevision: 0,
          expectedExists: true, seedData: { title: "Old seed" }, data: { title: "Stale seed" } }] }) });
      return Response.json({ removed, recreated, stale, seedResult: await seeded.json(), current: await storage.getEntrySnapshot("removed", "one") });
    }
    if (url.pathname === "/same") {
      const title = url.searchParams.get("title") ?? "unknown";
      return Response.json(await storage.commitEntries([{ collection: "pages", id: "home",
        expectedRevision: 0, expectedExists: false, data: { title },
        history: { operationId: `${run}-${title}`, ts: title === "A" ? 1 : 2, action: "put", data: null } }]));
    }
    if (url.pathname === "/distinct") {
      const id = url.searchParams.get("id") ?? "unknown";
      return Response.json(await storage.commitEntries([{ collection: "posts", id,
        expectedRevision: 0, expectedExists: false, data: { order: id === "a" ? 0 : 1 } }]));
    }
    if (url.pathname === "/advance-b") {
      return Response.json(await storage.commitEntries([{ collection: "posts", id: "b",
        expectedRevision: 1, expectedExists: true, data: { order: 2 } }]));
    }
    if (url.pathname === "/stale-batch") {
      return Response.json(await storage.commitEntries([
        { collection: "posts", id: "a", expectedRevision: 1, expectedExists: true, data: { order: 2 } },
        { collection: "posts", id: "b", expectedRevision: 1, expectedExists: true, data: { order: 0 } },
      ]));
    }
    if (url.pathname === "/retry") {
      return Response.json(await storage.commitEntries([{ collection: "pages", id: "home",
        expectedRevision: 0, expectedExists: false, data: { title: "retry" },
        history: { operationId: `${run}-retry`, ts: 3, action: "put", data: null } }]));
    }
    if (url.pathname === "/inspect") {
      return Response.json({
        sameEntryRevision: await storage.getRevision("pages", "home"),
        sameEntryHistory: await storage.getHistory("pages", "home"),
        postIds: await storage.listEntryIds("posts"),
        postA: await storage.getEntry("posts", "a"),
        postB: await storage.getEntry("posts", "b"),
      });
    }
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
