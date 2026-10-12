import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { issueEditorSessionCookie, getEditorId } from "../../packages/core/src/runtime/auth/session";
import { POST as mutate } from "../../packages/core/src/runtime/routes/mutate";
import { POST as publish } from "../../packages/core/src/runtime/routes/publish";
import { GET as entries } from "../../packages/core/src/runtime/routes/entries";
import { registerCollectionSchema } from "../../packages/core/src/runtime/schema-registry";
import { validateJsonSchema } from "../../packages/core/src/schema-utils";
import { parseFrontmatter } from "../../packages/core/src/runtime/storage/frontmatter-codec";
import { sanitizeHtml } from "../../packages/core/src/runtime/sanitize-html";
import { prepareFile, commitRun } from "../../packages/caretize/src/run";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";

vi.mock("../../packages/core/src/runtime/config.js", () => ({ getRuntimeConfig: () => ({ mountPath: "/admin", apiBasePath: "/api/cms", editorHome: "/" }) }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); __setRuntimeServicesForTests(null); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "caret-integrity-")); roots.push(root); return root; }
function session(preview = false) {
  const token = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
  return { get(name: string) { return name === "caret_session" ? { value: token } : name === "caret_preview" && preview ? { value: "1" } : undefined; } };
}
async function route(handler: (ctx: any) => Promise<Response>, cookies: ReturnType<typeof session>, path: string, body?: unknown) {
  const url = new URL(path, "http://localhost");
  const request = new Request(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-caret-request": "1" }, body: JSON.stringify(body) });
  const context = { request, url, cookies, locals: {} };
  return onRequest(context, () => handler(context));
}
function services(adapter: any) { __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() } }); }

it("accepts later schema alternatives, resolves references, and enforces oneOf and siblings", () => {
  const schema = { $defs: { a: { type: "object", properties: { kind: { const: "a" } } }, b: { type: "object", properties: { kind: { const: "b" } } } }, anyOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }] };
  expect(validateJsonSchema({ kind: "b" }, schema)).toEqual([]);
  expect(validateJsonSchema(false, schema)).not.toEqual([]);
  expect(validateJsonSchema(1, { oneOf: [{ type: "number" }, { type: "integer" }] })).not.toEqual([]);
  expect(validateJsonSchema("ok", { anyOf: [{ type: "string" }], minLength: 3 })).not.toEqual([]);
  expect(validateJsonSchema(1, { $defs: { n: { type: "number" } }, $ref: "#/$defs/n", minimum: 2 })).not.toEqual([]);
  expect(validateJsonSchema(1, { $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" })).not.toEqual([]);
});

it("bounds cyclic union references while permitting finite recursive values", () => {
  const cyclic = { $defs: { loop: { anyOf: [{ $ref: "#/$defs/loop" }, { $ref: "#/$defs/loop" }] } }, $ref: "#/$defs/loop" };
  expect(validateJsonSchema(false, cyclic)).not.toEqual([]);
  const recursive = { $defs: { node: { type: "object", properties: { next: { anyOf: [{ type: "null" }, { $ref: "#/$defs/node" }] } } } }, $ref: "#/$defs/node" };
  expect(validateJsonSchema({ next: { next: null } }, recursive)).toEqual([]);
});

it("rejects invalid layout updates without changing entry, revision, or history", async () => {
  const base = new InMemoryAdapter(); services(base);
  await base.writeEntry("release-layout", "one", { title: "One" });
  registerCollectionSchema("release-layout", { type: "object", additionalProperties: false, properties: { title: { type: "string" } } }, null);
  expect((await route(mutate, session(), "/api/cms/mutate", { type: "update_page_layout", collection: "release-layout", id: "one", sections: [{ id: "hero", key: "hero", enabled: true }] })).status).toBe(400);
  expect((await base.getEntry("release-layout", "one"))?.data).toEqual({ title: "One" });
  expect(await base.getRevision("release-layout", "one")).toBe(0);
  expect(await base.getHistory("release-layout", "one")).toEqual([]);
});

it("performs real-editor collection management on base even in preview", async () => {
  const base = new InMemoryAdapter(); services(base); const cookies = session(true);
  await base.writeEntry("release-old", "one", { title: "One" });
  expect((await route(mutate, cookies, "/api/cms/mutate", { type: "delete_collection", id: "release-old" })).status).toBe(200);
  expect(await base.isKnownCollection("release-old")).toBe(false);
  expect((await route(mutate, cookies, "/api/cms/mutate", { type: "create_collection", id: "release-new", label: "New", schema: { type: "object", properties: {} } })).status).toBe(200);
  expect(await base.isKnownCollection("release-new")).toBe(true);
  expect((await base.getCollectionMetadata("release-new"))?.label).toBe("New");
  expect((await (await route(publish, cookies, "/api/cms/publish", {})).json()).published).toEqual([]);
});

it("scoped publish journals only the approved source and preserves unrelated staged content", async () => {
  const root = await temp(); const contentRoot = join(root, "content");
  await mkdir(join(contentRoot, "posts"), { recursive: true });
  for (const id of ["one", "two"]) await writeFile(join(contentRoot, "posts", `${id}.md`), `---\ntitle: ${id}\n---\nBody`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Review"); git("config", "user.email", "review@example.invalid"); git("add", "content"); git("commit", "-qm", "seed");
  const base = new MarkdownAdapter({ contentRoot, metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") }); services(base); const cookies = session(true);
  expect((await route(mutate, cookies, "/api/cms/mutate", { type: "save_field", collection: "posts", id: "one", field: "title", value: "Approved" })).status).toBe(200);
  await writeFile(join(contentRoot, "posts", "two.md"), "---\ntitle: Unapproved\n---\nBody"); git("add", "content/posts/two.md");
  vi.stubEnv("CARET_GIT_ON_PUBLISH", "true");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const response = await route(publish, cookies, "/api/cms/publish", { collection: "posts", id: "one" }); cwd.mockRestore();
  expect(response.status).toBe(200); expect((await response.json()).commit).toMatch(/^[a-f0-9]{40}$/);
  expect(git("show", "--format=", "--name-only", "HEAD")).toBe("content/posts/one.md");
  expect(git("diff", "--cached", "--name-only")).toBe("content/posts/two.md");
});

it.each(["&id=one", ""])("a concurrent route save cannot attach a newer revision to an older read (%s)", async query => {
  const base = new InMemoryAdapter(); services(base); const cookies = session();
  await base.writeEntry("release-snapshot", "one", { title: "Old", note: "" });
  const getEntry = base.getEntry.bind(base);
  let release!: () => void; let observed!: () => void; let intercept = true;
  const observedRead = new Promise<void>(resolve => { observed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  base.getEntry = async (collection, id) => {
    const snapshot = await getEntry(collection, id);
    if (intercept) { intercept = false; observed(); await gate; }
    return snapshot;
  };
  const reader = route(entries, cookies, `/api/cms/entries?collection=release-snapshot${query}`);
  await observedRead;
  const writer = route(mutate, cookies, "/api/cms/mutate", { type: "save_field", collection: "release-snapshot", id: "one", field: "title", value: "New", expectedRevision: 0 });
  release();
  const snapshot = (await (await reader).json()).entries[0];
  expect(snapshot).toMatchObject({ data: { title: "Old" }, revision: 0 });
  expect((await writer).status).toBe(200);
  const staleSave = await route(mutate, cookies, "/api/cms/mutate", { type: "put_entry", collection: "release-snapshot", id: "one", data: { ...snapshot.data, note: "My edit" }, expectedRevision: snapshot.revision });
  expect(staleSave.status).toBe(409);
  expect((await getEntry("release-snapshot", "one"))?.data.title).toBe("New");
});

it("returns a missing entry's retained revision after deletion", async () => {
  const base = new InMemoryAdapter(); services(base); const cookies = session();
  await base.writeEntry("release-missing", "one", { title: "Old" });
  expect((await route(mutate, cookies, "/api/cms/mutate", { type: "delete_entry", collection: "release-missing", id: "one" })).status).toBe(200);
  const result = await (await route(entries, cookies, "/api/cms/entries?collection=release-missing&id=one")).json();
  expect(result.entries).toEqual([]); expect(result.revision).toBe(1);
});

it("decodes YAML Unicode escapes consistently and rejects unknown escapes", () => {
  expect(parseFrontmatter('---\ntags: ["\\u263A", "\\U0001F600", "\\x41"]\ntitle: "\\u263A"\n---\nBody')).toMatchObject({ ok: true, data: { tags: ["☺", "😀", "A"], title: "☺" } });
  expect(parseFrontmatter('---\ntags: ["\\q"]\n---\nBody').ok).toBe(false);
});

it("preserves entities and query parameters across sanitation while rejecting encoded unsafe URLs", () => {
  const input = '<a href="/search?a=1&amp;b=2">A &amp; B &copy; &#x1F600;</a>';
  const once = sanitizeHtml(input);
  expect(once).toBe('<a href="/search?a=1&amp;b=2">A &amp; B © 😀</a>');
  expect(sanitizeHtml(once)).toBe(once);
  expect(sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>')).toBe("<a>x</a>");
  expect(sanitizeHtml('<a href="/&#10;/evil.test">x</a>')).toBe("<a>x</a>");
  expect(sanitizeHtml('<a href="/&#92;evil.test">x</a>')).toBe("<a>x</a>");
  expect(sanitizeHtml("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
});

it("preflights every caretize input and preserves newer work and file mode", async () => {
  const root = await temp(); const source = "<h1>Original</h1>";
  const prepared = [];
  for (const id of ["one", "two"]) {
    await writeFile(join(root, `${id}.astro`), source);
    prepared.push(await prepareFile(`${id}.astro`, source, [{ startOffset: 0, attribute: `data-caret="pages::${id}::title"` }]));
  }
  await writeFile(join(root, "two.astro"), "<h1>Newer work</h1>");
  expect(() => commitRun(root, prepared, "2026-09-17T00-00-00Z")).toThrow(/source changed/);
  expect(await readFile(join(root, "one.astro"), "utf8")).toBe(source);
  expect(await readFile(join(root, "two.astro"), "utf8")).toContain("Newer work");
  await chmod(join(root, "one.astro"), 0o640);
  commitRun(root, [prepared[0]], "2026-09-17T00-00-01Z");
  expect((await stat(join(root, "one.astro"))).mode & 0o777).toBe(0o640);
});

it("nested rich bindings use original spans without damaging following markup", async () => {
  const base = new InMemoryAdapter(); await base.writeEntry("pages", "home", { parent: "Parent", child: "Much longer child" });
  const html = '<p data-caret="pages::home::parent" data-caret-rich><span data-caret="pages::home::child">x</span></p><script>globalThis.marker=0</script>';
  expect(await rewriteCaretAttributes(html, base)).toBe('<p data-caret="pages::home::parent" data-caret-rich>Parent</p><script>globalThis.marker=0</script>');
});

it("the publish route commits approved bytes after the same file changes at draft cleanup", async () => {
  const root = await temp(); const contentRoot = join(root, "content");
  await mkdir(join(contentRoot, "posts"), { recursive: true });
  const path = join(contentRoot, "posts/one.md");
  await writeFile(path, "---\ntitle: Original\n---\nOriginal body\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.name", "Review"); git("config", "user.email", "review@example.invalid"); git("add", "content"); git("commit", "-qm", "seed");
  const base = new MarkdownAdapter({ contentRoot, metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") });
  services(base); const cookies = session(true);
  const overlay = await base.makeEditorOverlay(getEditorId({ cookies })!);
  const deletion = overlay.deleteEntry.bind(overlay);
  const make = base.makeEditorOverlay.bind(base);
  base.makeEditorOverlay = async editor => editor === getEditorId({ cookies }) ? overlay : make(editor);
  expect((await route(mutate, cookies, "/api/cms/mutate", { type: "save_field", collection: "posts", id: "one", field: "title", value: "Approved" })).status).toBe(200);
  vi.spyOn(overlay, "deleteEntry").mockImplementationOnce(async (...args) => {
    await deletion(...args);
    await writeFile(path, "---\ntitle: Later external edit\n---\nChanged body\n");
  });
  vi.stubEnv("CARET_GIT_ON_PUBLISH", "true");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const response = await route(publish, cookies, "/api/cms/publish", { collection: "posts", id: "one" });
  const body = await response.json();
  expect(body.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(git("show", "HEAD:content/posts/one.md")).toBe("---\ntitle: Approved\n---\nOriginal body\n");
  expect(await readFile(path, "utf8")).toContain("Later external edit");
  expect(body).not.toHaveProperty("journalSources");
  expect(JSON.stringify(body)).not.toContain(root);
});
