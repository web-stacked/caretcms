import { describe, expect, it } from "vitest";
import {
  applyKeyRegistry,
  collectExistingKeys,
  deconflictKey,
} from "../../packages/caretize/src/keys";

const SCOPE = { collection: "pages", id: "home" };

function tag(field: string) {
  return {
    field,
    binding: `pages::home::${field}`,
    attribute: `data-caret="pages::home::${field}"`,
    candidate: { rich: false },
  };
}

function hoistProp(field: string, constName: string, literalValue: string) {
  const key = `pages::home::${field}`;
  return {
    key,
    constName,
    literalValue,
    constInsert: `\nconst ${constName} = await editable(${JSON.stringify(key)}, ${JSON.stringify(literalValue)});`,
  };
}

describe("collectExistingKeys", () => {
  it("collects full-triple attributes, scoped shorthands, and editable() keys", () => {
    const src = `---
const faqs = await editable("pages::home::faqs", [1]);
---
<main data-caret-scope="pages::home">
  <h1 data-caret="headline">Hi</h1>
  <h2 data-caret="pages::home::services">Services</h2>
</main>`;
    const keys = collectExistingKeys(src, SCOPE);
    expect(keys).toEqual(
      new Set(["pages::home::faqs", "pages::home::headline", "pages::home::services"]),
    );
  });

  it("ignores shorthand fields when no scope is known", () => {
    const keys = collectExistingKeys(`<h1 data-caret="headline">Hi</h1>`);
    expect(keys.size).toBe(0);
  });
});

describe("deconflictKey", () => {
  it("suffixes the field until free", () => {
    const used = new Set(["a::b::c", "a::b::c_2"]);
    expect(deconflictKey("a::b::c", used)).toBe("a::b::c_3");
    expect(deconflictKey("a::b::x", used)).toBe("a::b::x");
  });
});

describe("applyKeyRegistry (cross-tier collisions)", () => {
  it("a wrap colliding with a same-run tag takes a suffix", () => {
    // The audit's repro: <h2>Services</h2> tags pages::home::services while
    // `const services = [...]` wraps the SAME key — one key, two value shapes.
    const t = tag("services");
    const w = { key: "pages::home::services" };
    applyKeyRegistry("<main></main>", SCOPE, [t], [w], []);
    expect(t.binding).toBe("pages::home::services");
    expect(w.key).toBe("pages::home::services_2");
  });

  it("a tag colliding with a prior run's editable() key takes a suffix", () => {
    const src = `---
const services = await editable("pages::home::services", []);
---
<h2>Services</h2>`;
    const t = tag("services");
    applyKeyRegistry(src, SCOPE, [t], [], []);
    expect(t.binding).toBe("pages::home::services_2");
    expect(t.field).toBe("services_2");
    expect(t.attribute).toBe('data-caret="pages::home::services_2"');
  });

  it("hoist props deconflict and rebuild their constInsert", () => {
    const t = tag("title");
    const p = hoistProp("title", "heroTitle", "ABOUT US");
    applyKeyRegistry("<main></main>", SCOPE, [t], [], [{ props: [p] }]);
    expect(p.key).toBe("pages::home::title_2");
    expect(p.constInsert).toBe(
      '\nconst heroTitle = await editable("pages::home::title_2", "ABOUT US");',
    );
  });

  it("keeps rich tags rich when renamed", () => {
    const t = { ...tag("intro"), candidate: { rich: true } };
    t.attribute = `data-caret="pages::home::intro" data-caret-rich`;
    applyKeyRegistry(
      `<p data-caret="pages::home::intro">x</p>`,
      SCOPE,
      [t],
      [],
      [],
    );
    expect(t.attribute).toBe('data-caret="pages::home::intro_2" data-caret-rich');
  });

  it("no collisions → nothing changes", () => {
    const t = tag("headline");
    const w = { key: "pages::home::faqs" };
    const p = hoistProp("cta", "heroCta", "Go");
    const before = p.constInsert;
    applyKeyRegistry("<main></main>", SCOPE, [t], [w], [{ props: [p] }]);
    expect(t.binding).toBe("pages::home::headline");
    expect(w.key).toBe("pages::home::faqs");
    expect(p.constInsert).toBe(before);
  });
});
