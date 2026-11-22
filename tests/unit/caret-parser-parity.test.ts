/**
 * data-caret parser parity.
 *
 * The triple/scope resolution rules exist in five places: the rewrite engine
 * (canonical, fuzz-tested), the template scan (page-content-scan.ts),
 * browser-runtime.ts (cloud live-sync), the editor's static helpers.js, and
 * the dev-toolbar's deliberately inlined copy. The two
 * static-JS copies can't import the canonical implementation, so this test is
 * the lockstep mechanism: every copy must resolve the same corpus identically.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBinding, rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { scanTemplate } from "../../packages/core/src/page-content-scan";
import {
  getNearestScope,
  resolveBindingValue,
} from "../../packages/core/src/browser-runtime";
// helpers.js is dependency-free ESM, importable as-is.
// eslint-disable-next-line import/no-relative-packages
import {
  parseCaretAttr as helpersParse,
  resolveBinding as helpersResolve,
} from "../../packages/core/static/cms/editor/helpers.js";

/** Extract a top-level `function name(…) {…}` from raw JS source and return it
 *  as a callable. Lets us hold the dev-toolbar's module-private inlined copies
 *  to the corpus without importing the module (it imports astro/toolbar). */
function extractFunction(source: string, name: string): (...args: unknown[]) => unknown {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in source`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = source.indexOf("{", start);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  const text = source.slice(start, i + 1);
  return new Function(`${text}; return ${name};`)() as (...args: unknown[]) => unknown;
}

const appJs = readFileSync(
  fileURLToPath(
    new URL("../../packages/core/static/cms/dev-toolbar/app.js", import.meta.url),
  ),
  "utf8",
);
const toolbarParse = extractFunction(appJs, "parseCaretAttr");
const toolbarResolve = extractFunction(appJs, "resolveBinding");

/** Minimal element double for the DOM-walking copies: attribute bag + parent. */
type FakeEl = {
  getAttribute(name: string): string | null;
  parentElement: FakeEl | null;
  closest(selector: string): FakeEl | null;
};
function el(attrs: Record<string, string>, parent: FakeEl | null): FakeEl {
  const self: FakeEl = {
    getAttribute: (name) => attrs[name] ?? null,
    parentElement: parent,
    closest: (selector) => {
      // Only [data-caret-scope] is ever queried here.
      expect(selector).toBe("[data-caret-scope]");
      let node: FakeEl | null = self;
      while (node) {
        if (node.getAttribute("data-caret-scope") !== null) return node;
        node = node.parentElement;
      }
      return null;
    },
  };
  return self;
}

const SCOPE = { collection: "pages", id: "home" };

// value × scope corpus: triples, scoped fields, malformed shapes, edge strings.
const CORPUS: Array<{ value: string; scoped: boolean }> = [
  { value: "blog::post-1::title", scoped: false },
  { value: "blog::post-1::title", scoped: true }, // triple wins over scope
  { value: "headline", scoped: true },
  { value: "headline", scoped: false }, // unresolvable
  { value: "a::b", scoped: true }, // 2 parts — not a binding
  { value: "a::b::c::d", scoped: true }, // 4 parts — not a binding
  { value: "items.0.title", scoped: true }, // dot-path field
  { value: "::x::y", scoped: true }, // empty collection segment
];

function canonical(value: string, scoped: boolean) {
  return resolveBinding(value, scoped ? SCOPE : null);
}

describe("data-caret parser parity (4 copies)", () => {
  it("browser-runtime resolveBindingValue matches the rewrite engine", () => {
    for (const { value, scoped } of CORPUS) {
      expect(
        resolveBindingValue(value, scoped ? SCOPE : null),
        `value=${JSON.stringify(value)} scoped=${scoped}`,
      ).toEqual(canonical(value, scoped));
    }
  });

  it("editor helpers.js matches the rewrite engine", () => {
    for (const { value, scoped } of CORPUS) {
      const scopeEl = el({ "data-caret-scope": "pages::home" }, null);
      const element = el({ "data-caret": value }, scoped ? scopeEl : null);
      const resolved = helpersResolve(element, helpersParse(value));
      expect(resolved, `value=${JSON.stringify(value)} scoped=${scoped}`).toEqual(
        canonical(value, scoped),
      );
    }
  });

  it("dev-toolbar app.js inlined copy matches the rewrite engine", () => {
    for (const { value, scoped } of CORPUS) {
      const scopeEl = el({ "data-caret-scope": "pages::home" }, null);
      const element = el({ "data-caret": value }, scoped ? scopeEl : null);
      const resolved = toolbarResolve(element, toolbarParse(value));
      expect(resolved, `value=${JSON.stringify(value)} scoped=${scoped}`).toEqual(
        canonical(value, scoped),
      );
    }
  });

  it("an element's own data-caret-scope scopes its own binding, in every copy", async () => {
    const selfScoped = el({ "data-caret": "headline", "data-caret-scope": "pages::home" }, null);
    const expected = { collection: "pages", id: "home", field: "headline" };
    expect(getNearestScope(selfScoped as unknown as Element)).toEqual(SCOPE);
    expect(helpersResolve(selfScoped, helpersParse("headline"))).toEqual(expected);
    expect(toolbarResolve(selfScoped, toolbarParse("headline"))).toEqual(expected);

    // The rewrite engine and the template scan, on the same markup.
    const html = '<a data-caret-scope="pages::home" data-caret="headline">Template</a>';
    const adapter = new InMemoryAdapter();
    adapter.writeEntry("pages", "home", { headline: "Stored" });
    expect(await rewriteCaretAttributes(html, adapter)).toContain(">Stored</a>");
    expect(scanTemplate(html)).toEqual({ pages: { home: { headline: "Template" } } });
  });

  it("the own scope wins over an ancestor's, and a malformed one is skipped", () => {
    const outer = el({ "data-caret-scope": "pages::about" }, null);
    const own = el({ "data-caret": "headline", "data-caret-scope": "pages::home" }, outer);
    expect(getNearestScope(own as unknown as Element)).toEqual(SCOPE);
    expect(helpersResolve(own, helpersParse("headline"))).toMatchObject(SCOPE);
    expect(toolbarResolve(own, toolbarParse("headline"))).toMatchObject(SCOPE);

    const malformed = el({ "data-caret": "headline", "data-caret-scope": "nope" }, el({ "data-caret-scope": "pages::home" }, null));
    expect(getNearestScope(malformed as unknown as Element)).toEqual(SCOPE);
    expect(helpersResolve(malformed, helpersParse("headline"))).toMatchObject(SCOPE);
    expect(toolbarResolve(malformed, toolbarParse("headline"))).toMatchObject(SCOPE);
  });
});
