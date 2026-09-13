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
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const run = url.searchParams.get("run") ?? crypto.randomUUID();
    const storage = adapter(run);
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
