import { describe, expect, it } from "vitest";
import { promoteAttributeStega } from "../../packages/core/src/runtime/stega-attributes";
import { hasStega, stegaCombine } from "../../packages/core/src/runtime/stega";

const tag = (value: string, key: string) => stegaCombine(value, key);

describe("promoteAttributeStega", () => {
  it("strips keys from URL attributes so images and links keep working", () => {
    const html = `<a href="${tag("/about", "site::nav::links.0.href")}">${tag("About", "site::nav::links.0.label")}</a>`
      + `<video src="${tag("/hero.mp4", "site::home::video")}"></video>`;
    const out = promoteAttributeStega(html);
    expect(out).toContain('href="/about"');
    expect(out).toContain('src="/hero.mp4"');
    // Text keeps its key for the browser editor to promote.
    expect(hasStega(out.slice(out.indexOf(">") + 1))).toBe(true);
  });

  it("binds a keyed image so it can be replaced", () => {
    const html = `<img class="hero" src="${tag("/img/a.webp", "site::faq::image")}" alt="${tag("Room", "site::faq::imageAlt")}">`;
    expect(promoteAttributeStega(html)).toBe('<img class="hero" src="/img/a.webp" alt="Room" data-caret="site::faq::image">');
  });

  it("handles self-closing images and keeps an explicit binding", () => {
    expect(promoteAttributeStega(`<img src="${tag("/a.png", "pages::home::cover")}" />`))
      .toBe('<img src="/a.png" data-caret="pages::home::cover" />');
    expect(promoteAttributeStega(`<img data-caret="pages::home::other" src="${tag("/a.png", "pages::home::cover")}">`))
      .toBe('<img data-caret="pages::home::other" src="/a.png">');
  });

  it("ignores keys that are not bindings and leaves stega-free HTML untouched", () => {
    expect(promoteAttributeStega(`<img src="${tag("/a.png", { not: "a key" })}">`)).toBe('<img src="/a.png">');
    const plain = '<img src="/a.png"><a href="/b">B</a>';
    expect(promoteAttributeStega(plain)).toBe(plain);
  });

  it("does not touch keys inside comments or raw text", () => {
    const html = `<!-- <img src="${tag("/a.png", "pages::home::cover")}"> --><script>var u="${tag("/x", "pages::home::x")}"</script>`;
    expect(promoteAttributeStega(html)).toBe(html);
  });
});
