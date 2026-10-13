import { afterEach, expect, it, vi } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { GET as schema } from "../../packages/core/src/runtime/routes/schema";
import { GET as history } from "../../packages/core/src/runtime/routes/history";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { getEditorId, issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { createStudioEntryLoader } from "../../packages/core/static/cms/studio/entry-loader.js";

vi.mock("../../packages/core/src/runtime/config.js", () => ({ getRuntimeConfig: () => ({ mountPath: "/admin", apiBasePath: "/api/cms", editorHome: "/" }) }));

afterEach(() => { __setRuntimeServicesForTests(null); });

async function getSchema(adapter: InMemoryAdapter, query: string) {
  __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() } });
  const token = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
  const url = new URL(`/api/cms/schema?${query}`, "http://localhost");
  const context = { request: new Request(url), url, locals: {}, cookies: { get: (name: string) => name === "caret_session" ? { value: token } : undefined } };
  return (await onRequest(context as never, () => schema(context as never))).json();
}

async function pages() {
  const adapter = new InMemoryAdapter();
  // Listing order puts "about" first; its shape differs from "home".
  await adapter.writeEntry("pages", "about", { header: { title: "About" } });
  await adapter.writeEntry("pages", "home", { hero: { title: "Welcome", subtext: "Since 1947" }, faq: ["One"] });
  return adapter;
}

it("infers an existing entry's form from that entry, not the first entry", async () => {
  const body = await getSchema(await pages(), "collection=pages&id=home");
  expect(body).toMatchObject({ source: "inferred", inferredFrom: "home" });
  expect(Object.keys(body.schema.properties)).toEqual(["hero", "faq"]);
  expect(Object.keys(body.schema.properties.hero.properties)).toEqual(["title", "subtext"]);
});

it("keeps inferring a new entry's form from the first entry", async () => {
  const body = await getSchema(await pages(), "collection=pages");
  expect(body).toMatchObject({ source: "inferred", inferredFrom: "about" });
  expect(Object.keys(body.schema.properties)).toEqual(["header"]);
});

it("returns an empty inferred form for an unknown id", async () => {
  const body = await getSchema(await pages(), "collection=pages&id=missing");
  expect(body).toMatchObject({ source: "inferred", inferredFrom: null, schema: { type: "object", properties: {} } });
});

it("asks for an existing entry's schema by id and a new entry's by collection", async () => {
  const fetchImpl = vi.fn(async (url: string) => url.includes("/entries?")
    ? Response.json({ entries: [{ id: "home", data: { hero: {} }, revision: 1 }], revision: 1 })
    : Response.json({ schema: { type: "object" }, template: {} }));
  const loader = createStudioEntryLoader({ apiBasePath: "/api/cms", fetchImpl: fetchImpl as never });
  await loader.load({ collection: "pages", id: "home" });
  await loader.load({ collection: "pages", id: "draft-page", isNew: true });
  const schemaUrls = fetchImpl.mock.calls.map(([url]) => url).filter(url => url.includes("/schema?"));
  expect(schemaUrls).toEqual(["/api/cms/schema?collection=pages&id=home", "/api/cms/schema?collection=pages"]);
});

it("marks only the requesting editor's history snapshots as current", async () => {
  const adapter = await pages();
  __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() } });
  const token = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
  const url = new URL("/api/cms/history?collection=pages&id=home", "http://localhost");
  const context = { request: new Request(url), url, locals: {}, cookies: { get: (name: string) => name === "caret_session" ? { value: token } : undefined } };
  const own = await onRequest(context as never, async () => Response.json({ id: getEditorId(context as never) }));
  const editorId = (await own.json()).id as string;
  await adapter.appendHistory("pages", "home", { ts: 1, data: {}, editor: { id: editorId } } as never);
  await adapter.appendHistory("pages", "home", { ts: 2, data: {}, editor: { id: "someone-else" } } as never);
  const body = await (await onRequest(context as never, () => history(context as never))).json();
  const byTs = Object.fromEntries(body.history.map((item: { ts: number; editor: unknown }) => [item.ts, item.editor]));
  expect(byTs[1]).toEqual({ id: editorId, current: true });
  expect(byTs[2]).toEqual({ id: "someone-else" });
});
