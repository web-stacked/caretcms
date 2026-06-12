import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAstro } from "../../packages/caretize/src/parse";
import { prepareFile } from "../../packages/caretize/src/run";
import { detectCollectionBindTargets } from "../../packages/caretize/src/bind-collection";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/caretize/real/${name}`, import.meta.url)),
    "utf8",
  );
}

async function detect(src: string) {
  return detectCollectionBindTargets(src, await parseAstro(src));
}

describe("detectCollectionBindTargets", () => {
  it("does not bind the starlog fixture's div leaf — the rewrite engine can't render a div", async () => {
    // version_number is a <div> rendering {post.data.versionNumber}: the editor
    // would accept the binding but the rewrite engine never injects stored
    // values into a div, so binding it mints a silently inert storage key.
    // The date is a <FormattedDate> prop (cross-file) and must NOT be bound.
    expect(await detect(fixture("starlog-index.astro"))).toHaveLength(0);
  });

  it("does not bind leaf elements outside the rewrite-engine tag allowlist", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
<ul>{posts.map((post) => (
  <li><time>{post.data.date}</time><div>{post.data.body}</div><h2>{post.data.title}</h2></li>
))}</ul>`;
    const targets = await detect(src);
    expect(targets.map((t) => t.tag)).toEqual(["h2"]);
  });

  it("binds the right receiver when another declaration precedes getCollection", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const navItems = [{ data: { label: 'Home' } }];
const posts = await getCollection('blog');
---
<nav>{navItems.map((item) => (<span>{item.data.label}</span>))}</nav>
<ul>{posts.map((post) => (<li><h2>{post.data.title}</h2></li>))}</ul>`;
    const targets = await detect(src);
    // navItems is NOT a collection — its loop must stay unbound; posts must bind.
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ collection: "blog", field: "title", tag: "h2" });
    expect(targets[0].attribute).toBe("data-caret={`blog::${post.id}::title`}");
  });

  it("binds through a chained initializer", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const posts = (await getCollection('blog')).sort((a, b) => a.id.localeCompare(b.id));
---
<ul>{posts.map((post) => (<li><h2>{post.data.title}</h2></li>))}</ul>`;
    const targets = await detect(src);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ collection: "blog", field: "title" });
  });

  it("drops the context inside a nested loop that shadows the param name", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
const related = [{ data: { name: 'x' } }];
---
<ul>{posts.map((post) => (
  <li>
    <h2>{post.data.title}</h2>
    <ol>{related.map((post) => (<li><span>{post.data.name}</span></li>))}</ol>
  </li>
))}</ul>`;
    const targets = await detect(src);
    // Inside the related loop, `post` is a related row, not a blog entry.
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ collection: "blog", field: "title", tag: "h2" });
  });

  it("binds every direct-render field in a multi-field loop", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
<ul>{posts.map((post) => (
  <li><h2>{post.data.title}</h2><p>{post.data.excerpt}</p></li>
))}</ul>`;
    const targets = await detect(src);
    expect(targets.map((t) => t.field).sort()).toEqual(["excerpt", "title"]);
    expect(targets.every((t) => t.collection === "blog")).toBe(true);
  });

  it("does not bind a field passed as a component prop (deferred case)", async () => {
    const src = `---
import { getCollection } from 'astro:content';
import Card from '../components/Card.astro';
const items = await getCollection('work');
---
<div>{items.map((item) => (<Card title={item.data.title} />))}</div>`;
    expect(await detect(src)).toHaveLength(0);
  });

  it("does not bind an element that mixes literal text with the field", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
<ul>{posts.map((post) => (<li>Version {post.data.versionNumber}</li>))}</ul>`;
    expect(await detect(src)).toHaveLength(0);
  });

  it("returns nothing when there is no getCollection", async () => {
    const src = `---
const rows = [{ id: 'a' }];
---
<ul>{rows.map((row) => (<li>{row.data.x}</li>))}</ul>`;
    expect(await detect(src)).toHaveLength(0);
  });
});

describe("collection-bind transform applies + re-parses", () => {
  it("splices the dynamic data-caret and survives verification", async () => {
    const src = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
<ul>{posts.map((post) => (<li><h2>{post.data.title}</h2></li>))}</ul>`;
    const targets = await detect(src);
    const prepared = await prepareFile(
      "src/pages/index.astro",
      src,
      targets.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
    );
    expect(prepared.ok).toBe(true);
    expect(prepared.output).toContain("<h2 data-caret={`blog::${post.id}::title`}>{post.data.title}</h2>");
    // output still parses as valid Astro
    await expect(parseAstro(prepared.output)).resolves.toBeTruthy();
  });
});
