import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAstro, walkTags } from "../../packages/caretize/src/parse";
import { detect, type DetectResult } from "../../packages/caretize/src/detect";

async function detectSource(source: string): Promise<DetectResult> {
  const ast = await parseAstro(source);
  return detect(ast, walkTags);
}

function fixture(name: string): string {
  const url = new URL(`../fixtures/caretize/real/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("detect — synthetic cases", () => {
  it("tags a pure text-leaf heading as a high-confidence text candidate", async () => {
    const r = await detectSource("<main><h1>Welcome</h1></main>");
    const h1 = r.candidates.find((c) => c.tag === "h1");
    expect(h1).toBeDefined();
    expect(h1!.kind).toBe("text");
    expect(h1!.confidence).toBe("high");
    expect(h1!.text).toBe("Welcome");
  });

  it("skips an element whose text is an expression", async () => {
    const r = await detectSource("<main><h1>{title}</h1></main>");
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.some((s) => s.tag === "h1" && s.reason === "dynamic-content")).toBe(true);
  });

  it("skips an element with mixed inline children (engine can't round-trip)", async () => {
    const r = await detectSource('<main><p>see the <a href="/x">docs</a></p></main>');
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "mixed-children")).toBe(true);
    // ...but the inner <a> is itself a pure text leaf → a (medium) candidate
    expect(r.candidates.some((c) => c.tag === "a" && c.text === "docs")).toBe(true);
  });

  it("never tags components, and tags <img> by src", async () => {
    const r = await detectSource(
      '<main><MyCard>hi</MyCard><img src="/hero.png" alt="x" /></main>',
    );
    expect(r.candidates.some((c) => c.tag === "MyCard")).toBe(false);
    expect(r.skipped.some((s) => s.tag === "MyCard" && s.reason === "component")).toBe(true);
    const img = r.candidates.find((c) => c.tag === "img");
    expect(img?.kind).toBe("image");
    expect(img?.text).toBe("/hero.png");
  });

  it("is idempotent: an already-tagged element is skipped", async () => {
    const r = await detectSource(
      '<main data-caret-scope="pages::home"><h1 data-caret="headline">Hi</h1></main>',
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.every((s) => s.reason === "already-tagged")).toBe(true);
  });

  it("skips everything inside a .map() and flags the loop once", async () => {
    const src = "<ul>{items.map((i) => <li>{i.name}</li>)}</ul>";
    const r = await detectSource(src);
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.some((s) => s.tag === "li" && s.reason === "inside-iterator")).toBe(true);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].method).toBe("map");
  });
});

describe("detect — real withastro fixtures", () => {
  it("blog: tags the (emoji) h1, skips the mixed paragraphs, ignores components", async () => {
    const r = await detectSource(fixture("blog-index.astro"));

    const h1 = r.candidates.find((c) => c.tag === "h1");
    expect(h1).toBeDefined();
    expect(h1!.text).toContain("Hello, Astronaut!"); // emoji present, multibyte

    // The intro <p> wraps an <a>, so it is mixed-children → skipped.
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "mixed-children")).toBe(true);

    // BaseHead / Header / Footer are components → never candidates.
    for (const c of r.candidates) expect(c.node.type).toBe("element");
    expect(r.skipped.some((s) => s.tag === "Header" && s.reason === "component")).toBe(true);

    // Every candidate is a pure-text leaf or an image — never mixed.
    for (const c of r.candidates) {
      expect(["text", "image"]).toContain(c.kind);
    }
  });

  it("starlog: only the h1 is a candidate; the whole posts.map() is skipped + flagged", async () => {
    const r = await detectSource(fixture("starlog-index.astro"));

    expect(r.candidates.map((c) => c.tag)).toEqual(["h1"]);
    expect(r.candidates[0].text).toBe("Changelog");

    // The iterator is flagged exactly once.
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].method).toBe("map");

    // Elements inside the loop are skipped as inside-iterator (not tagged).
    expect(r.skipped.some((s) => s.tag === "a" && s.reason === "inside-iterator")).toBe(true);
    expect(r.skipped.some((s) => s.tag === "li" && s.reason === "inside-iterator")).toBe(true);
  });

  it("portfolio: produces candidates, and never tags a non-element or mixed node", async () => {
    const r = await detectSource(fixture("portfolio-index.astro"));
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.node.type).toBe("element");
      expect(["text", "image"]).toContain(c.kind);
    }
  });
});
