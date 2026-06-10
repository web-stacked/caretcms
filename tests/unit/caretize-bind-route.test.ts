import { describe, expect, it } from "vitest";
import { parseAstro } from "../../packages/caretize/src/parse";
import { detectRouteBindTargets } from "../../packages/caretize/src/bind-route";

async function detect(src: string) {
  return detectRouteBindTargets(src, await parseAstro(src));
}

/** A getStaticPaths detail route. `props` / `destructure` vary per test. */
function route(props: string, destructure: string, body: string): string {
  return `---
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
  const posts = await getCollection('blog');
  return posts.map((post) => ({ params: { slug: post.id }, props: ${props} }));
}
${destructure}
---
${body}`;
}

describe("detectRouteBindTargets", () => {
  it("binds a leaf field to the current entry (shorthand props)", async () => {
    const targets = await detect(
      route("{ post }", "const { post } = Astro.props;", "<h1>{post.data.title}</h1>"),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      collection: "blog",
      field: "title",
      tag: "h1",
      kind: "route",
    });
    expect(targets[0].attribute).toBe("data-caret={`blog::${post.id}::title`}");
  });

  it("resolves an explicit prop key (props: { entry: post })", async () => {
    const targets = await detect(
      route("{ entry: post }", "const { entry } = Astro.props;", "<h1>{entry.data.title}</h1>"),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].attribute).toBe("data-caret={`blog::${entry.id}::title`}");
  });

  it("follows a renamed destructure (const { entry: post } = Astro.props)", async () => {
    const targets = await detect(
      route("{ entry: post }", "const { entry: post } = Astro.props;", "<h1>{post.data.title}</h1>"),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].attribute).toBe("data-caret={`blog::${post.id}::title`}");
  });

  it("binds every leaf field on the page", async () => {
    const targets = await detect(
      route(
        "{ post }",
        "const { post } = Astro.props;",
        "<article><h1>{post.data.title}</h1><p>{post.data.description}</p></article>",
      ),
    );
    expect(targets.map((t) => t.field).sort()).toEqual(["description", "title"]);
    expect(targets.every((t) => t.collection === "blog")).toBe(true);
  });

  it("skips an element that already has a data-caret attribute", async () => {
    const targets = await detect(
      route(
        "{ post }",
        "const { post } = Astro.props;",
        '<h1 data-caret="blog::x::title">{post.data.title}</h1>',
      ),
    );
    expect(targets).toHaveLength(0);
  });

  it("does not bind a leaf that mixes literal text with the field", async () => {
    const targets = await detect(
      route("{ post }", "const { post } = Astro.props;", "<h1>Post: {post.data.title}</h1>"),
    );
    expect(targets).toHaveLength(0);
  });

  it("does not bind a field passed as a component prop", async () => {
    const targets = await detect(
      route("{ post }", "const { post } = Astro.props;", "<Title text={post.data.title} />"),
    );
    expect(targets).toHaveLength(0);
  });

  it("returns [] when the route has no getStaticPaths/getCollection", async () => {
    const src = `---
const { post } = Astro.props;
---
<h1>{post.data.title}</h1>`;
    expect(await detect(src)).toHaveLength(0);
  });

  it("bails (no binding) when two collections are mapped — never guess", async () => {
    const src = `---
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
  const posts = await getCollection('blog');
  const docs = await getCollection('docs');
  return [...posts, ...docs].map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}
const { entry } = Astro.props;
---
<h1>{entry.data.title}</h1>`;
    // `entry` is the array-merge param, not tied to a single getCollection
    // receiver, so the collection can't be resolved — bail rather than mis-bind.
    expect(await detect(src)).toHaveLength(0);
  });

  it("returns [] when the prop carrying the entry can't be resolved", async () => {
    // props spreads the whole entry; no key maps to the map param `post`.
    const targets = await detect(
      route("post", "const props = Astro.props;", "<h1>{post.data.title}</h1>"),
    );
    expect(targets).toHaveLength(0);
  });
});
