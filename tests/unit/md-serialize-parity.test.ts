import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  serializeBlock as tsSerialize,
  SerializeError as TsError,
  type SNode,
  type BlockContext,
} from "../../packages/core/src/markdown/serialize";
// The browser mirror ships as raw unbundled JS; importing it here is the whole
// point — a drift between the two serializers fails this test.
import {
  serializeBlock as jsSerialize,
  SerializeError as JsError,
} from "../../packages/core/static/cms/editor/md-serialize.js";

/**
 * Arbitrary inline SNode trees, including tags OUTSIDE the closed set (`span`,
 * `u`) so throw-parity is exercised too. Text mixes markdown specials.
 */
const textArb = fc
  .array(fc.constantFrom(..."*_`[]()#>-+<&\\ abc123.".split(""), "\n", "\t"), {
    minLength: 0,
    maxLength: 10,
  })
  .map((a) => a.join(""));

const leafArb: fc.Arbitrary<SNode> = fc.oneof(
  { weight: 4, arbitrary: textArb.map((value) => ({ type: "text", value }) as SNode) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom("strong", "b", "em", "i", "code", "a", "br", "span", "u"),
        textArb,
        fc.option(
          fc.constantFrom("https://a.co", "/p a", "mailto:x@y.co", "()<>", "/a\nb", "/a\rb"),
          { nil: undefined },
        ),
      )
      .map(
        ([tag, value, href]): SNode => ({
          type: "element",
          tag,
          attrs: href === undefined ? {} : { href },
          children: tag === "br" ? [] : [{ type: "text", value }],
        }),
      ),
  },
);

const treeArb = fc.array(leafArb, { minLength: 0, maxLength: 8 });

const ctxArb: fc.Arbitrary<BlockContext> = fc.oneof(
  fc.record({ block: fc.constant("paragraph" as const), nested: fc.boolean() }),
  fc.record({ block: fc.constant("heading" as const), level: fc.integer({ min: 0, max: 7 }) }),
);

describe("md serializer parity (core serialize.ts ↔ static md-serialize.js)", () => {
  it("both implementations produce identical output or throw together", () => {
    fc.assert(
      fc.property(treeArb, ctxArb, (tree, ctx) => {
        let tsOut: string | null = null;
        let tsThrew = false;
        try {
          tsOut = tsSerialize(tree, ctx);
        } catch (e) {
          tsThrew = true;
          expect(e).toBeInstanceOf(TsError);
        }

        let jsOut: string | null = null;
        let jsThrew = false;
        try {
          jsOut = jsSerialize(tree, ctx);
        } catch (e) {
          jsThrew = true;
          expect(e).toBeInstanceOf(JsError);
        }

        expect(jsThrew).toBe(tsThrew);
        if (!tsThrew) expect(jsOut).toBe(tsOut);
      }),
      { numRuns: 1000 },
    );
  });

  it("agrees on a representative fixed corpus", () => {
    const t = (value: string): SNode => ({ type: "text", value });
    const el = (tag: string, children: SNode[], attrs: Record<string, string> = {}): SNode => ({
      type: "element",
      tag,
      attrs,
      children,
    });
    const cases: Array<[SNode[], BlockContext]> = [
      [[t("plain")], { block: "paragraph", nested: false }],
      [[el("strong", [t("a")]), el("strong", [t("b")])], { block: "paragraph", nested: false }],
      [[el("code", [t("a`b")])], { block: "paragraph", nested: false }],
      [[el("a", [t("x")], { href: "/a b" })], { block: "heading", level: 3 }],
      [[t("- item")], { block: "paragraph", nested: false }],
      [[t("1. item")], { block: "paragraph", nested: false }],
    ];
    for (const [tree, ctx] of cases) {
      expect(jsSerialize(tree, ctx)).toBe(tsSerialize(tree, ctx));
    }
  });
});
