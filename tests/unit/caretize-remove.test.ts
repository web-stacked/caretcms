import { describe, expect, it } from "vitest";
import { savedTemplateText, stripBindings, unwireConfig } from "../../packages/caretize/src/remove";

describe("stripBindings", () => {
  it("removes every binding attribute and nothing else", async () => {
    const source = `---
const title = "Hi";
---
<section class="hero" data-caret-scope="pages::home">
  <h1 data-caret="headline">Our work</h1>
  <div class="intro" data-caret="intro" data-caret-rich set:html={intro} />
  <img
    src="/a.png"
    alt="A"
    data-caret="pages::home::cover"
  />
  <p>Plain</p>
</section>
`;
    const result = await stripBindings(source);
    expect(result).toMatchObject({ ok: true, removed: 5 });
    expect(result.output).toBe(`---
const title = "Hi";
---
<section class="hero">
  <h1>Our work</h1>
  <div class="intro" set:html={intro} />
  <img
    src="/a.png"
    alt="A"
  />
  <p>Plain</p>
</section>
`);
  });

  it("keeps edits made around the attributes", async () => {
    const source = `<main>\n  <h1 data-caret="pages::home::headline">Hello</h1>\n  <section class="new">Added later</section>\n</main>\n`;
    expect((await stripBindings(source)).output).toBe(`<main>\n  <h1>Hello</h1>\n  <section class="new">Added later</section>\n</main>\n`);
  });

  it("handles expression values, spreads and attributes that only look similar", async () => {
    const source = `<a {...rest} data-caret={\`posts::\${id}::title\`} href={url} data-caretaker="x" title="data-caret=">{title}</a>`;
    expect((await stripBindings(source)).output).toBe(`<a {...rest} href={url} data-caretaker="x" title="data-caret=">{title}</a>`);
  });

  it("leaves a file without bindings untouched", async () => {
    const source = `<p class="data-caret">data-caret="x" in prose</p>`;
    expect(await stripBindings(source)).toEqual({ ok: true, output: source, removed: 0 });
  });

  it("works inside expressions and with non-ASCII text", async () => {
    const source = `<ul>{items.map((item) => (<li data-caret-scope={\`services::\${item.id}\`}><h3 data-caret="title">Bäume — „schön“ {item.title}</h3></li>))}</ul>`;
    expect((await stripBindings(source)).output).toBe(`<ul>{items.map((item) => (<li><h3>Bäume — „schön“ {item.title}</h3></li>))}</ul>`);
  });
});

describe("unwireConfig", () => {
  it("undoes what init writes", () => {
    const wired = `// @ts-check\nimport { defineConfig } from 'astro/config';\nimport caret from '@caretcms/core';\n\nexport default defineConfig({\n  integrations: [caret()],\n});\n`;
    expect(unwireConfig(wired)).toBe(`// @ts-check\nimport { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n});\n`);
  });

  it("removes one entry among several, with its options", () => {
    const wired = `import mdx from "@astrojs/mdx";\nimport caret from "@caretcms/core";\nexport default defineConfig({\n  integrations: [mdx(), caret({ delivery: { mode: "static" }, brand: { name: "A (b)" } }), sitemap()],\n});\n`;
    expect(unwireConfig(wired)).toBe(`import mdx from "@astrojs/mdx";\nexport default defineConfig({\n  integrations: [mdx(), sitemap()],\n});\n`);
  });

  it("removes a last entry with the comma before it", () => {
    const wired = `import caret from '@caretcms/core';\nexport default { integrations: [mdx(), caret()] };\n`;
    expect(unwireConfig(wired)).toBe(`export default { integrations: [mdx()] };\n`);
  });

  it("gives up on shapes it can't be sure about", () => {
    expect(unwireConfig(`import caret, { markdownStorage } from '@caretcms/core';\nexport default { integrations: [caret({ storage: markdownStorage() })] };\n`)).toBeNull();
    expect(unwireConfig(`export default {};\n`)).toBeNull();
  });
});

describe("savedTemplateText", () => {
  it("lists the lines that hold text saved over a template", () => {
    const file = `---\nheadline: "Our best work"\nkontakt: "Call us"\nother: 1\n"__caret_template__":\n  headline: t38925866\n  "hero.cta": t11111111\nhero:\n  cta: Ring\n---\n\nBody\n`;
    expect(savedTemplateText(file)).toEqual([`headline: "Our best work"`, `hero:`]);
  });

  it("is empty for content with no record", () => {
    expect(savedTemplateText(`---\ntitle: Post\n---\nBody`)).toEqual([]);
    expect(savedTemplateText(`No frontmatter`)).toEqual([]);
  });
});
