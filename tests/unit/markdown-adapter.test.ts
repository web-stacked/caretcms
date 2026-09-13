import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";

describe("MarkdownAdapter", () => {
  let workdir: string;
  let contentRoot: string;
  let adapter: MarkdownAdapter;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "caret-md-"));
    contentRoot = join(workdir, "content");
    adapter = new MarkdownAdapter({
      contentRoot,
      metaRoot: join(workdir, "meta"),
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  /** Write a fixture markdown file under a collection. */
  async function seed(collection: string, name: string, body: string): Promise<void> {
    const dir = join(contentRoot, collection);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body, "utf8");
  }

  describe("getEntry", () => {
    it("returns null for a missing entry", async () => {
      expect(await adapter.getEntry("blog", "nope")).toBeNull();
    });

    it("parses .md frontmatter into data", async () => {
      await seed("blog", "hello.md", `---\ntitle: Hello\ndraft: false\n---\n# Body\n`);
      expect(await adapter.getEntry("blog", "hello")).toEqual({
        id: "hello",
        data: { title: "Hello", draft: false },
      });
    });

    it("reads a .mdx file when no .md exists", async () => {
      await seed("blog", "post.mdx", `---\ntitle: MDX\n---\n<Component />\n`);
      expect(await adapter.getEntry("blog", "post")).toEqual({ id: "post", data: { title: "MDX" } });
    });

    it("prefers .md over .mdx when both exist", async () => {
      await seed("blog", "dupe.md", `---\nfrom: md\n---\n`);
      await seed("blog", "dupe.mdx", `---\nfrom: mdx\n---\n`);
      expect((await adapter.getEntry("blog", "dupe"))?.data).toEqual({ from: "md" });
    });

    it("returns null for an id that violates the id contract (no traversal)", async () => {
      expect(await adapter.getEntry("blog", "../secret")).toBeNull();
    });

    it("returns null for a collection that violates the name contract (no traversal)", async () => {
      expect(await adapter.getEntry("../../etc", "passwd")).toBeNull();
    });

    it("throws (fails loud) on unparseable frontmatter", async () => {
      await seed("blog", "bad.md", `---\nbody: &anchor value\n---\n`);
      await expect(adapter.getEntry("blog", "bad")).rejects.toThrow(/unsupported_content/);
    });
  });

  describe("listEntryIds", () => {
    it("returns sorted ids matching the id contract", async () => {
      await seed("blog", "beta.md", `---\nt: b\n---\n`);
      await seed("blog", "alpha.md", `---\nt: a\n---\n`);
      expect(await adapter.listEntryIds("blog")).toEqual(["alpha", "beta"]);
    });

    it("skips filenames that fail the id contract", async () => {
      await seed("blog", "Good.md", `---\n---\n`); // uppercase
      await seed("blog", "ok.md", `---\n---\n`);
      await seed("blog", "notes.txt", `frontless`);
      expect(await adapter.listEntryIds("blog")).toEqual(["ok"]);
    });

    it("dedupes a stem present as both .md and .mdx", async () => {
      await seed("blog", "x.md", `---\n---\n`);
      await seed("blog", "x.mdx", `---\n---\n`);
      expect(await adapter.listEntryIds("blog")).toEqual(["x"]);
    });

    it("does not descend into subdirectories", async () => {
      await seed("blog", "top.md", `---\n---\n`);
      await mkdir(join(contentRoot, "blog", "2024"), { recursive: true });
      await writeFile(join(contentRoot, "blog", "2024", "nested.md"), `---\n---\n`, "utf8");
      expect(await adapter.listEntryIds("blog")).toEqual(["top"]);
    });
  });

  describe("listEntries", () => {
    it("skips a malformed entry instead of failing the whole collection", async () => {
      await seed("blog", "good.md", `---\ntitle: Good\n---\n`);
      await seed("blog", "bad.md", `---\nx: &a 1\ny: *a\n---\n`);
      const entries = await adapter.listEntries("blog");
      expect(entries).toEqual([{ id: "good", data: { title: "Good" } }]);
    });
  });

  describe("writeEntry", () => {
    it("rewrites frontmatter in place, preserving the body byte-for-byte", async () => {
      const body = "# Heading\n\nParagraph with a literal --- inside.\n";
      await seed("blog", "post.md", `---\ntitle: Old\nviews: 1\n---\n${body}`);

      await adapter.writeEntry("blog", "post", { title: "New", views: 2 });

      const raw = await readFile(join(contentRoot, "blog", "post.md"), "utf8");
      expect(raw).toBe(`---\ntitle: New\nviews: 2\n---\n${body}`);
      expect(await adapter.getEntry("blog", "post")).toEqual({
        id: "post",
        data: { title: "New", views: 2 },
      });
    });

    it("writes back to the .mdx file when the entry is MDX, body untouched", async () => {
      const body = `import Hero from '../c/Hero.astro';\n\n<Hero />\n`;
      await seed("blog", "mdxpost.mdx", `---\ntitle: Old\n---\n${body}`);

      await adapter.writeEntry("blog", "mdxpost", { title: "New" });

      const raw = await readFile(join(contentRoot, "blog", "mdxpost.mdx"), "utf8");
      expect(raw).toBe(`---\ntitle: New\n---\n${body}`);
    });

    it("creates a new .md file (with empty body) when none exists", async () => {
      await adapter.writeEntry("blog", "fresh", { title: "Fresh" });
      const raw = await readFile(join(contentRoot, "blog", "fresh.md"), "utf8");
      expect(raw).toBe(`---\ntitle: Fresh\n---\n`);
    });

    it("refuses to overwrite an entry whose existing frontmatter is unparseable", async () => {
      await seed("blog", "bad.md", `---\nbody: &anchor value\n---\nkeep me\n`);
      await expect(adapter.writeEntry("blog", "bad", { title: "x" })).rejects.toThrow(
        /Refusing to overwrite/,
      );
      // File must be untouched.
      const raw = await readFile(join(contentRoot, "blog", "bad.md"), "utf8");
      expect(raw).toBe(`---\nbody: &anchor value\n---\nkeep me\n`);
    });

    it("rejects an invalid id without writing", async () => {
      await expect(adapter.writeEntry("blog", "../escape", { a: 1 })).rejects.toThrow(
        /invalid entry path/,
      );
    });

    it("round-trips nested objects and arrays", async () => {
      await adapter.writeEntry("blog", "nested", {
        seo: { title: "T", description: "D" },
        tags: ["a", "b"],
      });
      expect((await adapter.getEntry("blog", "nested"))?.data).toEqual({
        seo: { title: "T", description: "D" },
        tags: ["a", "b"],
      });
    });
  });

  describe("deleteEntry", () => {
    it("removes both .md and .mdx forms; is a no-op when absent", async () => {
      await seed("blog", "gone.md", `---\n---\n`);
      await seed("blog", "gone.mdx", `---\n---\n`);
      await adapter.deleteEntry("blog", "gone");
      expect(await adapter.getEntry("blog", "gone")).toBeNull();
      await expect(adapter.deleteEntry("blog", "missing")).resolves.toBeUndefined();
    });
  });

  describe("collections", () => {
    it("discovers content directories with valid names", async () => {
      await seed("blog", "a.md", `---\n---\n`);
      await seed("gallery", "b.md", `---\n---\n`);
      expect(await adapter.discoverCollections()).toEqual(["blog", "gallery"]);
    });

    it("isKnownCollection reflects discovery and rejects bad names", async () => {
      await seed("blog", "a.md", `---\n---\n`);
      expect(await adapter.isKnownCollection("blog")).toBe(true);
      expect(await adapter.isKnownCollection("missing")).toBe(false);
      expect(await adapter.isKnownCollection("Bad Name")).toBe(false);
    });

    it("discovers a metadata-only collection created via createCollection", async () => {
      await adapter.createCollection({
        id: "press",
        label: "Press",
        schema: { type: "object", properties: {} },
        created_at: 0,
        updated_at: 0,
      });
      expect(await adapter.discoverCollections()).toContain("press");
      expect(await adapter.isKnownCollection("press")).toBe(true);
    });

    it("deleteCollection never deletes source content (only sidecar state)", async () => {
      await seed("blog", "keep.md", `---\ntitle: keep\n---\n`);
      await adapter.deleteCollection("blog");
      // Source file must survive.
      expect(await adapter.getEntry("blog", "keep")).toEqual({
        id: "keep",
        data: { title: "keep" },
      });
    });
  });

  describe("revisions / history (delegated)", () => {
    it("tracks revisions in the sidecar, not the .md file", async () => {
      await seed("blog", "rev.md", `---\ntitle: x\n---\nbody\n`);
      expect(await adapter.getRevision("blog", "rev")).toBe(0);
      expect(await adapter.bumpRevision("blog", "rev")).toBe(1);
      expect(await adapter.bumpRevision("blog", "rev")).toBe(2);
      // The markdown file must carry no revision noise.
      const raw = await readFile(join(contentRoot, "blog", "rev.md"), "utf8");
      expect(raw).toBe(`---\ntitle: x\n---\nbody\n`);
    });

    it("appends and reads history", async () => {
      await adapter.appendHistory("blog", "p", { ts: 1, action: "save", data: { title: "v1" } });
      const history = await adapter.getHistory("blog", "p");
      expect(history).toEqual([{ ts: 1, action: "save", data: { title: "v1" } }]);
    });
  });
});
