import { describe, expect, it } from "vitest";
import { contentEtag, GET, sanitizePath } from "../../packages/core/src/runtime/routes/editor-assets";

function request(path: string, etag?: string) {
  const headers = etag ? { "if-none-match": etag } : undefined;
  return GET({ params: { path }, request: new Request(`http://localhost/__caret/${path}`, { headers }) } as never);
}

describe("editor-assets caching", () => {
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
});

describe("editor-assets path sanitization", () => {
  it.each([
    ["editor.js"],
    ["editor.css"],
    ["editor/toolbar.js"],
    ["studio.css"],
    ["nested/deep/path/file.svg"],
  ])("accepts legitimate asset path %s", (input) => {
    expect(sanitizePath(input)).toBe(input);
  });

  it.each([
    ["../etc/passwd"],
    ["editor/../../secret"],
    [".."],
    ["foo/..bar"],
    ["editor.js\0.png"],
    ["editor.js;rm -rf /"],
    ["editor.js?x=1"],
    ["editor.js#frag"],
    ["editor.js%2e%2e"],
    ["editor.js$INJECT"],
    ["editor.js`backtick`"],
    ["foo bar.js"],
  ])("rejects malicious or malformed path %s", async (input) => {
    expect(sanitizePath(input)).toBeNull();
    const res = await request(input);
    expect(res.status).toBe(404);
  });

  it("normalizes Windows backslashes before checking", () => {
    expect(sanitizePath("editor\\toolbar.js")).toBe("editor/toolbar.js");
    expect(sanitizePath("..\\etc\\passwd")).toBeNull();
  });
});
