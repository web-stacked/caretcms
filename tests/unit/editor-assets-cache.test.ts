import { expect, it } from "vitest";
import { contentEtag, GET } from "../../packages/core/src/runtime/routes/editor-assets";

function request(path: string, etag?: string) {
  const headers = etag ? { "if-none-match": etag } : undefined;
  return GET({ params: { path }, request: new Request(`http://localhost/__caret/${path}`, { headers }) } as never);
}

it("revalidates package assets by content hash instead of caching them for a fixed time", async () => {
  const first = await request("studio.css");
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("public, no-cache");
  const etag = first.headers.get("etag");
  expect(etag).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);

  const unchanged = await request("studio.css", etag!);
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");

});

it("derives distinct, stable ETags from asset contents", () => {
  expect(contentEtag(".a { color: red; }")).toBe(contentEtag(".a { color: red; }"));
  expect(contentEtag(".a { color: red; }")).not.toBe(contentEtag(".a { color: blue; }"));
  expect(contentEtag("ab")).not.toBe(contentEtag("ba"));
});
