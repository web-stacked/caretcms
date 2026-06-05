import { describe, expect, it } from "vitest";
import { parseAstro } from "../../packages/caretize/src/parse";
import {
  classifyConstUsage,
  mapParamIdents,
} from "../../packages/caretize/src/usage";

async function classify(template: string, varName: string, opts = {}) {
  const root = await parseAstro(template);
  return classifyConstUsage(root, varName, opts);
}

describe("mapParamIdents", () => {
  it("extracts a parenthesized arrow param", () => {
    expect(mapParamIdents("services.map((s) => x)", "services")).toEqual(["s"]);
  });
  it("extracts a parenless arrow param", () => {
    expect(mapParamIdents("xs.map(s => x)", "xs")).toEqual(["s"]);
  });
  it("takes only the first param (ignores the index)", () => {
    expect(mapParamIdents("xs.flatMap((a, i) => x)", "xs")).toEqual(["a"]);
  });
  it("extracts destructured binding identifiers", () => {
    expect(mapParamIdents("xs.map(({ title, url }) => x)", "xs").sort()).toEqual([
      "title",
      "url",
    ]);
  });
  it("handles a function-expression callback", () => {
    expect(mapParamIdents("xs.map(function (p) { return p })", "xs")).toEqual(["p"]);
  });
  it("ignores maps over a different variable", () => {
    expect(mapParamIdents("other.map((q) => q)", "xs")).toEqual([]);
  });
  it("skips the async keyword and reads the real param", () => {
    expect(mapParamIdents("xs.map(async (item) => item)", "xs")).toEqual(["item"]);
  });
  it("keeps a plain param that has a default value", () => {
    expect(mapParamIdents("xs.map((item = {}) => item)", "xs")).toEqual(["item"]);
  });
  it("does not match a substring receiver (xs vs xsList)", () => {
    expect(mapParamIdents("xsList.map((q) => q)", "xs")).toEqual([]);
  });
  it("with no receiver, collects every map/flatMap binding (nested)", () => {
    expect(
      mapParamIdents("groups.map((g) => g.items.map((i) => i))").sort(),
    ).toEqual(["g", "i"]);
  });
});

describe("classifyConstUsage", () => {
  it("safe when every field renders as element text", async () => {
    const v = await classify(`<ul>{items.map((i) => <li>{i.title}</li>)}</ul>`, "items");
    expect(v.safe).toBe(true);
    expect(v.handoffs).toEqual([]);
  });

  it("UNSAFE when a field lands in a native-element attribute", async () => {
    const v = await classify(
      `<ul>{items.map((i) => <a href={i.url}>{i.title}</a>)}</ul>`,
      "items",
    );
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(/href/);
  });

  it("UNSAFE for <img src> built from a field", async () => {
    const v = await classify(`{items.map((i) => <img src={i.src} />)}`, "items");
    expect(v.safe).toBe(false);
  });

  it("ignores static quoted attributes (no false positive)", async () => {
    const v = await classify(
      `{items.map((i) => <li class="card">{i.title}</li>)}`,
      "items",
    );
    expect(v.safe).toBe(true);
  });

  it("UNSAFE for a destructured field used in an attribute", async () => {
    const v = await classify(
      `{items.map(({ url, title }) => <a href={url}>{title}</a>)}`,
      "items",
    );
    expect(v.safe).toBe(false);
  });

  it("UNSAFE for a spread of the loop item onto a native element", async () => {
    const v = await classify(`{items.map((i) => <li {...i}>x</li>)}`, "items");
    expect(v.safe).toBe(false);
  });

  it("component prop hand-off is lenient by default and recorded", async () => {
    const v = await classify(`{items.map((i) => <Card title={i.title} />)}`, "items");
    expect(v.safe).toBe(true);
    expect(v.handoffs).toEqual([{ component: "Card", prop: "title" }]);
  });

  it("component prop hand-off is UNSAFE under componentHandoffUnsafe", async () => {
    const v = await classify(`{items.map((i) => <Card title={i.title} />)}`, "items", {
      componentHandoffUnsafe: true,
    });
    expect(v.safe).toBe(false);
  });

  it("records a direct whole-const prop hand-off (no loop)", async () => {
    const v = await classify(`<Features items={items} />`, "items");
    expect(v.safe).toBe(true);
    expect(v.handoffs).toEqual([{ component: "Features", prop: "items" }]);
  });

  it("UNSAFE when the whole const flows into a native attribute", async () => {
    const v = await classify(`<div data-x={items}>x</div>`, "items");
    expect(v.safe).toBe(false);
  });

  // Regression guards for identifier-matching false positives (a field reaching
  // a native attribute that the classifier must NOT miss → otherwise corruption).
  it("UNSAFE for a `$`-prefixed loop variable in an attribute", async () => {
    const v = await classify(`{items.map(($item) => <a href={$item.url}>x</a>)}`, "items");
    expect(v.safe).toBe(false);
  });

  it("UNSAFE for a `$`-named const used directly in an attribute", async () => {
    const v = await classify(`<a href={$data[0].url}>x</a>`, "$data");
    expect(v.safe).toBe(false);
  });

  it("UNSAFE for an async-arrow loop whose field hits an attribute", async () => {
    const v = await classify(
      `{items.map(async (i) => <a href={i.url}>{i.title}</a>)}`,
      "items",
    );
    expect(v.safe).toBe(false);
  });

  it("UNSAFE for a default-param loop whose field hits an attribute", async () => {
    const v = await classify(`{items.map((i = {}) => <img src={i.src} />)}`, "items");
    expect(v.safe).toBe(false);
  });

  it("UNSAFE for a nested-map field reaching an attribute", async () => {
    const v = await classify(
      `{groups.map((g) => g.items.map((i) => <a href={i.url}>{i.title}</a>))}`,
      "groups",
    );
    expect(v.safe).toBe(false);
  });
});
