import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAstro, walkTags } from "../../packages/caretize/src/parse";
import { detect, type DetectOptions, type DetectResult } from "../../packages/caretize/src/detect";
import { imageComponentNames } from "../../packages/caretize/src/frontmatter";
import { planFile } from "../../packages/caretize/src/plan";

async function detectSource(source: string, options?: DetectOptions): Promise<DetectResult> {
  const ast = await parseAstro(source);
  return detect(ast, walkTags, options);
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

  it("marks sanitizer-safe inline mixed content as rich-eligible (no --rich)", async () => {
    const r = await detectSource('<main><p>see the <a href="/x">docs</a></p></main>');
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "rich-eligible")).toBe(true);
    // not promoted, so the inner <a> is still its own (medium) candidate
    expect(r.candidates.some((c) => c.tag === "a" && c.text === "docs")).toBe(true);
  });

  it("promotes a sanitizer-safe inline block to a rich candidate under --rich", async () => {
    const r = await detectSource('<main><p>see the <a href="/x">docs</a></p></main>', { rich: true });
    const p = r.candidates.find((c) => c.tag === "p");
    expect(p?.rich).toBe(true);
    expect(p?.confidence).toBe("medium");
    // the rich field owns its subtree — the inner <a> is NOT tagged separately
    expect(r.candidates.some((c) => c.tag === "a")).toBe(false);
    expect(r.skipped.some((s) => s.tag === "a" && s.reason === "inside-rich")).toBe(true);
  });

  it("reports inline content carrying ONLY a class as rich-class-promotable (not unsafe)", async () => {
    const r = await detectSource('<main><p>hi <strong class="accent">there</strong></p></main>', { rich: true });
    // class is recoverable via allowedClasses → promotable with --rich-class, not lost
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "rich-class-promotable")).toBe(true);
    expect(r.candidates.some((c) => c.tag === "p")).toBe(false);
  });

  it("refuses inline content carrying a NON-class stripped attr as rich-unsafe-attrs", async () => {
    const r = await detectSource('<main><p>hi <strong style="color:red">there</strong></p></main>', { rich: true });
    // style can't be blessed → genuinely lossy, never promotable
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "rich-unsafe-attrs")).toBe(true);
    expect(r.candidates.some((c) => c.tag === "p")).toBe(false);
  });

  it("promotes a class-only block to rich under --rich-class", async () => {
    const r = await detectSource('<main><p>hi <strong class="accent">there</strong></p></main>', { rich: true, richClass: true });
    const p = r.candidates.find((c) => c.tag === "p");
    expect(p?.rich).toBe(true);
    expect(r.skipped.some((s) => s.tag === "p")).toBe(false);
  });

  it("still skips genuine block/component mixed content as mixed-children", async () => {
    const r = await detectSource("<main><p>hi <Widget>x</Widget> there</p></main>", { rich: true });
    // a component child is not a sanitizer-allowed inline tag → not promotable
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "mixed-children")).toBe(true);
  });

  it("promotes a <span>-wrapped run as rich (span is now sanitizer-allowed, W4)", async () => {
    const r = await detectSource("<main><p>hi <span><em>x</em></span> there</p></main>", { rich: true });
    // <span> joined the rich inline allowlist → the <p> is now rich, not mixed-children
    const p = r.candidates.find((c) => c.tag === "p");
    expect(p?.rich).toBe(true);
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "mixed-children")).toBe(false);
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
    // Receiver is captured so the CLI can drop the flag once a wrap tier covers it.
    expect(r.flags[0].receiver).toBe("items");
  });

  it("captures no receiver for an expression-chained loop (still flags)", async () => {
    const src = "<ul>{getItems().map((i) => <li>{i.name}</li>)}</ul>";
    const r = await detectSource(src);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].method).toBe("map");
    expect(r.flags[0].receiver).toBeUndefined();
  });
});

// ─── W2: astro:assets <Image>/<Picture> ─────────────────────────────────────

const IMG_COMPONENTS = new Set(["Image", "Picture"]);

describe("imageComponentNames", () => {
  it("extracts Image and Picture from an astro:assets import", () => {
    const fm = `import { Image, Picture } from "astro:assets";`;
    expect([...imageComponentNames(fm)].sort()).toEqual(["Image", "Picture"]);
  });

  it("resolves an alias to its local name", () => {
    expect([...imageComponentNames(`import { Image as Img } from "astro:assets";`)]).toEqual([
      "Img",
    ]);
  });

  it("captures a (legacy) default import of astro:assets", () => {
    expect([...imageComponentNames(`import Image from "astro:assets";`)]).toEqual(["Image"]);
  });

  it("does NOT match a same-named import from another specifier", () => {
    expect([...imageComponentNames(`import { Image } from "./my-image";`)]).toEqual([]);
  });
});

describe("detect — astro:assets image components", () => {
  it("tags a top-level <Image> as an image candidate by its static src", async () => {
    const r = await detectSource('<main><Image src="/hero.png" alt="Hero" /></main>', {
      imageComponents: IMG_COMPONENTS,
    });
    const img = r.candidates.find((c) => c.tag === "Image");
    expect(img?.kind).toBe("image");
    expect(img?.confidence).toBe("high");
    expect(img?.text).toBe("/hero.png");
  });

  it("recognizes an aliased component name", async () => {
    const r = await detectSource('<main><Img src="/hero.png" alt="x" /></main>', {
      imageComponents: new Set(["Img"]),
    });
    expect(r.candidates.some((c) => c.tag === "Img" && c.kind === "image")).toBe(true);
  });

  it("tags <Picture> as well", async () => {
    const r = await detectSource('<main><Picture src="/photo.jpg" alt="x" /></main>', {
      imageComponents: IMG_COMPONENTS,
    });
    expect(r.candidates.some((c) => c.tag === "Picture" && c.kind === "image")).toBe(true);
  });

  it("emits a candidate with empty text for an expression src (no author-time URL)", async () => {
    const r = await detectSource("<main><Image src={heroImage} alt=\"x\" /></main>", {
      imageComponents: IMG_COMPONENTS,
    });
    const img = r.candidates.find((c) => c.tag === "Image");
    expect(img?.kind).toBe("image");
    expect(img?.text).toBe("");
  });

  it("defers an <Image> inside a .map() — skipped inside-iterator, not tagged", async () => {
    const r = await detectSource(
      "<ul>{photos.map((p) => <Image src={p.src} alt={p.alt} />)}</ul>",
      { imageComponents: IMG_COMPONENTS },
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.some((s) => s.tag === "Image" && s.reason === "inside-iterator")).toBe(true);
  });

  it("leaves a user's OWN component alone when it isn't an astro:assets import", async () => {
    const r = await detectSource('<main><Image src="/x.png" /></main>'); // no imageComponents
    expect(r.candidates.some((c) => c.tag === "Image")).toBe(false);
    expect(r.skipped.some((s) => s.tag === "Image" && s.reason === "component")).toBe(true);
  });

  it("skips an <Image> with no src as empty", async () => {
    const r = await detectSource('<main><Image alt="x" /></main>', {
      imageComponents: IMG_COMPONENTS,
    });
    expect(r.candidates.some((c) => c.tag === "Image")).toBe(false);
    expect(r.skipped.some((s) => s.tag === "Image" && s.reason === "empty")).toBe(true);
  });
});

describe("planFile — astro:assets end to end", () => {
  const PAGE = `---
import { Image } from "astro:assets";
import hero from "../assets/hero.png";
---
<main><Image src={hero} alt="Hero" /></main>
`;

  it("resolves Image components and plans a data-caret binding for the rendered <img> src", async () => {
    const plan = await planFile(PAGE, "src/pages/index.astro");
    const img = plan.tags.find((t) => t.candidate.tag === "Image");
    expect(img).toBeDefined();
    expect(img!.candidate.kind).toBe("image");
    expect(img!.binding).toBe("pages::home::hero");
  });

  it("--no-images suppresses the Image binding", async () => {
    const plan = await planFile(PAGE, "src/pages/index.astro", { noImages: true });
    expect(plan.tags.some((t) => t.candidate.tag === "Image")).toBe(false);
  });
});

describe("detect — real withastro fixtures", () => {
  it("blog: tags the (emoji) h1, skips the mixed paragraphs, ignores components", async () => {
    const r = await detectSource(fixture("blog-index.astro"));

    const h1 = r.candidates.find((c) => c.tag === "h1");
    expect(h1).toBeDefined();
    expect(h1!.text).toContain("Hello, Astronaut!"); // emoji present, multibyte

    // Links and inline code are safe rich content; without --rich they stay unbound.
    expect(r.skipped.some((s) => s.tag === "p" && s.reason === "rich-eligible")).toBe(true);

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
