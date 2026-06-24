import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bakeStaticHtmlFiles,
  bakeStaticHtmlString,
} from "../../packages/core/src/runtime/static-bake";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

describe("static HTML bake", () => {
  let adapter: InMemoryAdapter;
  let dir: string;

  beforeEach(async () => {
    adapter = new InMemoryAdapter();
    await adapter.writeEntry("pages", "home", {
      title: "Stored title",
      body: "<strong class=\"text-brand\">Stored rich</strong>",
      hero: "/uploads/hero.jpg",
    });
    dir = await mkdtemp(join(tmpdir(), "caret-bake-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites an HTML string using stored CaretCMS values", async () => {
    const result = await bakeStaticHtmlString(
      '<h1 data-caret="pages::home::title">Default title</h1>',
      { adapter },
    );

    expect(result.rewritten).toBe(true);
    expect(result.html).toContain("Stored title");
    expect(result.html).not.toContain("Default title");
  });

  it("skips strings without rendered binding attributes", async () => {
    const html = "<p>This page documents data-caret in prose only.</p>";
    const result = await bakeStaticHtmlString(html, { adapter });

    expect(result).toEqual({ html, rewritten: false });
  });

  it("rewrites every changed HTML file under a build directory", async () => {
    await mkdir(join(dir, "blog"), { recursive: true });
    const indexPath = join(dir, "index.html");
    const blogPath = join(dir, "blog", "index.html");
    const assetPath = join(dir, "asset.txt");

    await writeFile(
      indexPath,
      '<h1 data-caret="pages::home::title">Default title</h1>',
      "utf8",
    );
    await writeFile(
      blogPath,
      '<img data-caret="pages::home::hero" src="/default.jpg">',
      "utf8",
    );
    await writeFile(assetPath, '<p data-caret="pages::home::title">Nope</p>', "utf8");

    const result = await bakeStaticHtmlFiles(dir, { adapter });

    expect(result.scanned).toBe(2);
    expect(result.rewritten).toBe(2);
    expect(await readFile(indexPath, "utf8")).toContain("Stored title");
    expect(await readFile(blogPath, "utf8")).toContain('src="/uploads/hero.jpg"');
    expect(await readFile(assetPath, "utf8")).toContain("Nope");
  });

  it("passes rich-text class allowlists through to the rewrite engine", async () => {
    const result = await bakeStaticHtmlString(
      '<p data-caret="pages::home::body" data-caret-rich>Default</p>',
      {
        adapter,
        allowedClasses: { strong: ["text-*"] },
      },
    );

    expect(result.html).toContain('class="text-brand"');
    expect(result.html).toContain("Stored rich");
  });
});
