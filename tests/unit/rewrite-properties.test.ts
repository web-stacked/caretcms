import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

// Property-based fuzzing of the rewrite engine — the fragile core. Rather than
// enumerating cases by hand (which missed the bare-<img> and would miss the
// next one), generate random documents + override sets and assert invariants
// that must hold for every input. Counterexamples are shrunk to a minimal repro.

// --- Generators -------------------------------------------------------------

const TEXT_TAGS = ["h1", "p", "span", "strong", "em", "li", "figcaption"] as const;
const COLLECTIONS = ["pages", "site", "blog"] as const;
const IDS = ["home", "about", "post-1"] as const;

type Spec = {
  kind: "text" | "img";
  scoped: boolean;
  selfClose: boolean; // img only: `<img .../>` vs `<img ...>`
  tag: string;
  collection: string;
  id: string;
  field: string; // unique per spec; may be a dotted (nested) path
  template: string; // plain template content / original src
  stored: string; // the override value (the fuzz payload)
  present: boolean; // whether the override exists in storage
};

// Plain template text: no `<`, `>`, `&`, or `"` so the template element stays a
// leaf (no child markup) and structural assertions are unambiguous.
const plainText = fc
  .stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 -_".split("")), {
    maxLength: 12,
  });

// Override payloads: ordinary strings plus the nasty literals that have bitten
// HTML rewriters — markup injection, attribute breakout, and `$`-substitution
// patterns that String.prototype.replace interprets specially.
const overloadValue = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "<script>alert(1)</script>",
    '"><script>alert(1)</script>',
    "a < b && c > d",
    "$&",
    "$1",
    "$$",
    "$`",
    "$'",
    "/img.png?a=1&b=2",
    'plain "quoted" value',
    "",
  ),
);

const specArb: fc.Arbitrary<Omit<Spec, "field">> = fc.record({
  kind: fc.constantFrom("text", "img"),
  scoped: fc.boolean(),
  selfClose: fc.boolean(),
  tag: fc.constantFrom(...TEXT_TAGS),
  collection: fc.constantFrom(...COLLECTIONS),
  id: fc.constantFrom(...IDS),
  template: plainText,
  stored: overloadValue,
  present: fc.boolean(),
});

const docArb: fc.Arbitrary<Spec[]> = fc
  .array(specArb, { minLength: 1, maxLength: 8 })
  // Give every element a unique field so each binding's expected output is
  // independent — no cross-element coupling to reason about.
  .chain((specs) =>
    fc.tuple(...specs.map((_, i) => fc.constantFrom(`f${i}`, `n${i}.deep`))).map((fields) =>
      specs.map((s, i) => ({ ...s, field: fields[i] })),
    ),
  );

// --- Rendering + storage ----------------------------------------------------

function attrFor(spec: Spec): string {
  return spec.scoped ? spec.field : `${spec.collection}::${spec.id}::${spec.field}`;
}

function renderSpec(spec: Spec): string {
  const attr = attrFor(spec);
  let el: string;
  if (spec.kind === "text") {
    el = `<${spec.tag} data-caret="${attr}">${spec.template}</${spec.tag}>`;
  } else {
    const close = spec.selfClose ? " />" : ">";
    el = `<img data-caret="${attr}" src="${spec.template || "/orig.png"}"${close}`;
  }
  return spec.scoped
    ? `<section data-caret-scope="${spec.collection}::${spec.id}">${el}</section>`
    : el;
}

function renderDoc(specs: Spec[]): string {
  return `<main>${specs.map(renderSpec).join("\n")}</main>`;
}

function setNested(obj: Record<string, unknown>, path: string, value: string): void {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    cur[keys[i]] = (cur[keys[i]] as Record<string, unknown>) ?? {};
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

async function makeAdapter(specs: Spec[]): Promise<InMemoryAdapter> {
  const data: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const spec of specs) {
    if (!spec.present) continue;
    data[spec.collection] ??= {};
    data[spec.collection][spec.id] ??= {};
    setNested(data[spec.collection][spec.id], spec.field, spec.stored);
  }
  const adapter = new InMemoryAdapter();
  for (const [collection, entries] of Object.entries(data)) {
    for (const [id, fields] of Object.entries(entries)) {
      await adapter.writeEntry(collection, id, fields);
    }
  }
  return adapter;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Properties -------------------------------------------------------------

describe("rewrite engine — properties", () => {
  it("is the identity when storage is empty", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (specs) => {
        const html = renderDoc(specs);
        const out = await rewriteCaretAttributes(html, new InMemoryAdapter());
        expect(out).toBe(html);
      }),
      { numRuns: 300 },
    );
  });

  it("preserves every data-caret binding (structure is not dropped)", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (specs) => {
        const html = renderDoc(specs);
        const out = await rewriteCaretAttributes(html, await makeAdapter(specs));
        const count = (s: string) => (s.match(/data-caret="/g) ?? []).length;
        expect(count(out)).toBe(count(html));
        expect((out.match(/<img\b/g) ?? []).length).toBe((html.match(/<img\b/g) ?? []).length);
      }),
      { numRuns: 300 },
    );
  });

  it("applies each stored override to its bound element (text + img, void + self-closing)", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (specs) => {
        const html = renderDoc(specs);
        const out = await rewriteCaretAttributes(html, await makeAdapter(specs));
        for (const spec of specs) {
          if (!spec.present) continue;
          const attr = attrFor(spec);
          if (spec.kind === "text") {
            expect(out).toContain(
              `<${spec.tag} data-caret="${attr}">${escapeHtml(spec.stored)}</${spec.tag}>`,
            );
          } else {
            expect(out).toContain(`data-caret="${attr}" src="${escapeAttr(spec.stored)}"`);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("is idempotent — rewriting the output again changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (specs) => {
        const adapter = await makeAdapter(specs);
        const html = renderDoc(specs);
        const once = await rewriteCaretAttributes(html, adapter);
        const twice = await rewriteCaretAttributes(once, adapter);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it("never emits unescaped markup from a stored value (no injection)", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (specs) => {
        const html = renderDoc(specs);
        const out = await rewriteCaretAttributes(html, await makeAdapter(specs));
        // The template never contains markup, so any "<script" in the output
        // could only have come from an unescaped stored value.
        expect(out.includes("<script")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});
