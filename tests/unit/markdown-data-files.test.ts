import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { parseDataFile, writeDataEntry } from "../../packages/core/src/runtime/storage/data-file-codec";

const SITE = `[
  {
    "id": "settings",
    "brand": "marby",
    "menu": [{ "label": "HOME", "href": "/" }]
  },
  {
    "id": "faq",
    "title": "questions & answers",
    "image": "/faq.webp"
  }
]
`;

describe("data-file codec", () => {
  it("keeps entry order, key order, indentation, and the trailing newline", () => {
    const file = parseDataFile(SITE)!;
    const out = writeDataEntry(file, "faq", { image: "/new.webp", title: "Questions" });
    expect(JSON.parse(out)[1]).toEqual({ id: "faq", title: "Questions", image: "/new.webp" });
    expect(Object.keys(JSON.parse(out)[1])).toEqual(["id", "title", "image"]);
    expect(out.endsWith("]\n")).toBe(true);
    expect(out.split("\n")[1]).toBe("  {");
  });

  it("supports objects keyed by id and rejects other shapes", () => {
    const file = parseDataFile('{\n\t"home": { "title": "Hi" }\n}')!;
    expect(JSON.parse(writeDataEntry(file, "about", { title: "About" }))).toEqual({ home: { title: "Hi" }, about: { title: "About" } });
    expect(writeDataEntry(file, "home", null)).toBe("{}");
    expect(parseDataFile('["a", "b"]')).toBeNull();
    expect(parseDataFile('{"version": 2}')).toBeNull();
    expect(parseDataFile("not json")).toBeNull();
  });
});

describe("MarkdownAdapter data files", () => {
  let workdir: string;
  let contentRoot: string;
  let adapter: MarkdownAdapter;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "caret-data-"));
    contentRoot = join(workdir, "content");
    await mkdir(join(contentRoot, "blog"), { recursive: true });
    await writeFile(join(contentRoot, "blog", "hello.md"), "---\ntitle: Hello\n---\nBody\n");
    await writeFile(join(contentRoot, "site.json"), SITE);
    adapter = new MarkdownAdapter({ contentRoot, metaRoot: join(workdir, "meta"), draftsRoot: join(workdir, "drafts") });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("discovers the data file as a collection and reads entries without their id", async () => {
    expect(await adapter.discoverCollections()).toEqual(["blog", "site"]);
    expect(await adapter.listEntryIds("site")).toEqual(["settings", "faq"]);
    expect(await adapter.getEntry("site", "faq")).toEqual({ id: "faq", data: { title: "questions & answers", image: "/faq.webp" } });
    expect(await adapter.isDocumentCollection("site")).toBe(false);
    expect(await adapter.isDocumentCollection("blog")).toBe(true);
    expect(await adapter.readBodySource("site", "faq")).toBeNull();
  });

  it("writes one entry back into the same file and never creates Markdown files", async () => {
    await adapter.writeEntry("site", "faq", { title: "Questions buyers ask", image: "/faq.webp" });
    const saved = JSON.parse(await readFile(join(contentRoot, "site.json"), "utf8"));
    expect(saved[1]).toEqual({ id: "faq", title: "Questions buyers ask", image: "/faq.webp" });
    expect(saved[0].brand).toBe("marby");
    expect(await readdir(contentRoot)).toEqual(["blog", "site.json"]);
  });

  it("serializes concurrent writes to different entries in the same file", async () => {
    await Promise.all([
      adapter.writeEntry("site", "faq", { title: "A", image: "/faq.webp" }),
      adapter.writeEntry("site", "settings", { brand: "B", menu: [] }),
    ]);
    const saved = JSON.parse(await readFile(join(contentRoot, "site.json"), "utf8"));
    expect(saved.map((item: { id: string }) => item.id)).toEqual(["settings", "faq"]);
    expect(saved[0].brand).toBe("B");
    expect(saved[1].title).toBe("A");
  });

  it("publishes a draft into the data file and records history", async () => {
    const overlay = await adapter.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(adapter, overlay);
    expect((await executeMutation(draft, { type: "save_field", collection: "site", id: "faq", field: "title", value: "Ask us" })).ok).toBe(true);
    expect(JSON.parse(await readFile(join(contentRoot, "site.json"), "utf8"))[1].title).toBe("questions & answers");

    const result = await publishOverlay(adapter, overlay);
    expect(result.conflicts).toEqual([]);
    expect(result.published).toEqual([expect.objectContaining({ collection: "site", id: "faq" })]);
    const saved = JSON.parse(await readFile(join(contentRoot, "site.json"), "utf8"));
    expect(saved[1]).toEqual({ id: "faq", title: "Ask us", image: "/faq.webp" });
    expect(await readdir(contentRoot)).toEqual(["blog", "site.json"]);
    expect(await adapter.getRevision("site", "faq")).toBe(1);
    expect((await adapter.getHistory("site", "faq"))[0].data).toEqual({ title: "questions & answers", image: "/faq.webp" });
  });

  it("prepares Git publication sources as the whole updated data file", async () => {
    const [source] = await adapter.preparePublicationSources("site", "faq", { title: "New", image: "/faq.webp" });
    expect(source.path).toBe(join(contentRoot, "site.json"));
    expect(JSON.parse(source.content!)[1].title).toBe("New");
  });

  it("keeps a Markdown directory authoritative over a same-named data file", async () => {
    await writeFile(join(contentRoot, "blog.json"), '[{ "id": "other", "title": "Ignored" }]');
    expect(await adapter.listEntryIds("blog")).toEqual(["hello"]);
    expect(await adapter.isDocumentCollection("blog")).toBe(true);
  });
});
