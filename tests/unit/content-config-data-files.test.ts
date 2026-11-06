import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { contentConfigDataFiles, parseContentConfig, uneditableCollections } from "../../packages/core/src/runtime/storage/content-config";

const ROOT = "/site";

describe("content config reader", () => {
  it("finds file() paths bound through variables and the collections export", () => {
    const config = `
import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({ title: z.string() }),
});
// const ghost = defineCollection({ loader: file('src/data/ghost.json') });
const menu = defineCollection({
  loader: file('src/data/menu.json'),
  schema: z.object({ name: z.string(), note: z.string().default("a, b) {") }),
});
const staff = defineCollection({ loader: file("src/data/team.json", { parser: (text) => JSON.parse(text) }) });

export const collections = { posts, menu, team: staff };
`;
    expect(parseContentConfig(config, ROOT)).toEqual([
      { name: "posts", loader: "glob", base: "/site/src/content/posts" },
      { name: "menu", loader: "file", path: "/site/src/data/menu.json", parser: false },
      { name: "team", loader: "file", path: "/site/src/data/team.json", parser: true },
    ]);
  });

  it("reads inline collections, renamed imports, and quoted keys", () => {
    const config = `
import { defineCollection } from "astro:content";
import { file as fromFile } from "astro/loaders";
export const collections = {
  "prices": defineCollection({ loader: fromFile(\`data/prices.json\`) }),
  remote: defineCollection({ loader: async () => [] }),
  dynamic: defineCollection({ loader: fromFile(path) }),
};
`;
    expect(parseContentConfig(config, ROOT)).toEqual([
      { name: "prices", loader: "file", path: "/site/data/prices.json", parser: false },
      { name: "remote", loader: "other" },
      { name: "dynamic", loader: "other" },
    ]);
  });

  it("returns null without a readable collections export", () => {
    expect(parseContentConfig("export default {}", ROOT)).toBeNull();
  });
});

describe("markdown storage with file() collections outside the content root", () => {
  let root: string;
  const menu = `[
  { "id": "rye", "name": "Seeded Rye", "price": 8.5 },
  { "id": "chai", "name": "House Chai", "price": 5 }
]
`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caret-file-loader-"));
    await mkdir(join(root, "src", "content", "posts"), { recursive: true });
    await mkdir(join(root, "src", "data"), { recursive: true });
    await writeFile(join(root, "src", "content", "posts", "hello.md"), "---\ntitle: Hello\n---\nBody\n");
    await writeFile(join(root, "src", "data", "menu.json"), menu);
    await writeFile(join(root, "src", "content.config.ts"), `
import { defineCollection } from "astro:content";
import { glob, file } from "astro/loaders";
const posts = defineCollection({ loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }) });
const menu = defineCollection({ loader: file("src/data/menu.json") });
const feed = defineCollection({ loader: file("src/data/feed.yaml") });
export const collections = { posts, menu, feed };
`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function adapter() {
    return new MarkdownAdapter({ contentRoot: join(root, "src", "content"), metaRoot: join(root, ".caretcms"), projectRoot: root });
  }

  it("lists, reads, and writes the entries in place, keeping formatting", async () => {
    const storage = adapter();
    expect(await storage.discoverCollections()).toEqual(["menu", "posts"]);
    expect(await storage.isDocumentCollection("menu")).toBe(false);
    expect(await storage.listEntryIds("menu")).toEqual(["rye", "chai"]);
    expect(await storage.getEntry("menu", "chai")).toEqual({ id: "chai", data: { name: "House Chai", price: 5 } });

    await storage.writeEntry("menu", "chai", { name: "Masala Chai", price: 5 });
    expect(await readFile(join(root, "src", "data", "menu.json"), "utf8")).toBe(menu.replace("House Chai", "Masala Chai"));
    expect(await storage.committableEntryPaths("menu", "chai", false)).toEqual([join(root, "src", "data", "menu.json")]);
    const [publication] = await storage.preparePublicationSources("menu", "rye", { name: "Rye", price: 8.5 });
    expect(publication.path).toBe(join(root, "src", "data", "menu.json"));
    expect(JSON.parse(publication.content!)[0]).toEqual({ id: "rye", name: "Rye", price: 8.5 });
  });

  it("ignores a configured file that isn't a list or object of entries", async () => {
    await writeFile(join(root, "src", "data", "menu.json"), '{ "items": [{ "id": "a" }] }');
    expect(await adapter().discoverCollections()).toEqual(["posts"]);
  });

  it("names the collections it can't edit", () => {
    const contentRoot = join(root, "src", "content");
    expect(contentConfigDataFiles(root)).toEqual(new Map([["menu", join(root, "src", "data", "menu.json")]]));
    expect(uneditableCollections(root, contentRoot)).toEqual(["feed (src/data/feed.yaml isn't JSON)"]);
  });
});
