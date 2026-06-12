/**
 * data-caret parser parity.
 *
 * The triple/scope resolution rules exist in four places: the rewrite engine
 * (canonical, fuzz-tested), browser-runtime.ts (cloud live-sync), the editor's
 * static helpers.js, and the dev-toolbar's deliberately inlined copy. The two
 * static-JS copies can't import the canonical implementation, so this test is
 * the lockstep mechanism: every copy must resolve the same corpus identically.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBinding } from "../../packages/core/src/runtime/rewrite";
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
  // closest() is what browser-runtime uses; emulate the ancestors-only walk
  // it performs via parentElement?.closest(...).
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

  it("scope comes from ancestors only — an element's own data-caret-scope does not scope its own binding", () => {
    // The server's scope stack only sees tags opened BEFORE the bound element,
    // so all client copies must walk from parentElement, never self.
    const selfScoped = el(
      { "data-caret": "headline", "data-caret-scope": "pages::home" },
      null,
    );
    expect(getNearestScope(selfScoped as unknown as Element)).toBeNull();
    expect(helpersResolve(selfScoped, helpersParse("headline"))).toBeNull();
    expect(toolbarResolve(selfScoped, toolbarParse("headline"))).toBeNull();
  });
});
