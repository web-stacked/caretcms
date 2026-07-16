import { describe, expect, it } from "vitest";
import { caretSatteriPlugin } from "../../packages/core/src/markdown/satteri";
import { transformCaretRemark } from "../../packages/core/src/markdown/remark";
import { computeStamp } from "../../packages/core/src/markdown/stamp";

const CONTENT_ROOT = "/project/src/content";
const FILE = "/project/src/content/blog/hello.md";

// A source + mdast tree with real offsets (from a Sätteri render probe), so
// both frontends see identical positions and must agree on every attribute.
const SOURCE = "# Heading\n\nTop paragraph.\n\n- item one\n- item two\n\n> quoted para";

interface N {
  type: string;
  position: { start: { offset: number }; end: { offset: number } };
  children?: N[];
  data?: { hProperties?: Record<string, unknown> };
}
const pos = (start: number, end: number) => ({ start: { offset: start }, end: { offset: end } });

function buildTree(): N {
  return {
    type: "root",
    position: pos(0, SOURCE.length),
    children: [
      { type: "heading", position: pos(0, 9) },
      { type: "paragraph", position: pos(11, 25) },
      {
        type: "list",
        position: pos(27, 48),
        children: [
          { type: "listItem", position: pos(27, 37), children: [{ type: "paragraph", position: pos(29, 37) }] },
          { type: "listItem", position: pos(38, 48), children: [{ type: "paragraph", position: pos(40, 48) }] },
        ],
      },
      { type: "blockquote", position: pos(50, 63), children: [{ type: "paragraph", position: pos(52, 63) }] },
    ],
  };
}

/** Run the Sätteri frontend against a tree via a mock context. */
function runSatteri(tree: N): void {
  const parents = new WeakMap<N, N>();
  const index = new WeakMap<N, number>();
  const link = (node: N) =>
    node.children?.forEach((c, i) => {
      parents.set(c, node);
      index.set(c, i);
      link(c);
    });
  link(tree);

  const ctx = {
    fileURL: new URL(`file://${FILE}`),
    source: SOURCE,
    parent: (n: N) => parents.get(n),
    indexOf: (n: N) => index.get(n),
    setProperty: (n: N, _key: "data", value: { hProperties?: Record<string, unknown> }) => {
      n.data = value;
    },
  };
  const plugin = caretSatteriPlugin({ contentRoot: CONTENT_ROOT }) as unknown as {
    heading?: (n: N, c: typeof ctx) => void;
    paragraph?: (n: N, c: typeof ctx) => void;
  };
  const visit = (node: N) => {
    if (node.type === "heading") plugin.heading?.(node, ctx);
    if (node.type === "paragraph") plugin.paragraph?.(node, ctx);
    node.children?.forEach(visit);
  };
  visit(tree);
}

/** Collect hProperties for every node, keyed by type+offset, for comparison. */
function collect(tree: N): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (n: N) => {
    if (n.data?.hProperties) out[`${n.type}@${n.position.start.offset}`] = n.data.hProperties;
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

describe("stamp frontend parity (satteri ↔ remark)", () => {
  it("both frontends assign identical attributes to identical trees", () => {
    const satteriTree = buildTree();
    runSatteri(satteriTree);

    const remarkTree = buildTree();
    transformCaretRemark(remarkTree, { value: SOURCE, path: FILE, toString: () => SOURCE }, CONTENT_ROOT);

    const s = collect(satteriTree);
    const r = collect(remarkTree);
    expect(r).toEqual(s);
    // Sanity: it actually stamped the expected blocks (heading, para, 2 li, bq para).
    expect(Object.keys(s)).toHaveLength(5);
  });
});

describe("canonical offset base (fact 4.6)", () => {
  it("identical canonical body from different pipeline source bases", () => {
    const canonicalBody = "# Heading\n\nBody paragraph.";
    const shared = {
      fileURL: `file://${FILE}`,
      contentRoot: CONTENT_ROOT,
      blockPath: [0],
      ancestorTypes: [] as string[],
      nested: false,
    };

    // Base A: content-collection body (already trimmed) — delta 0.
    const a = computeStamp({ ...shared, source: canonicalBody, start: 0, end: 9 });
    // Base B: `.md` import — frontmatter blanked to whitespace, body shifted.
    const blanked = "   \n            \n   \n\n";
    const sourceB = blanked + canonicalBody;
    const b = computeStamp({
      ...shared,
      source: sourceB,
      start: blanked.length,
      end: blanked.length + 9,
    });
    // Base C: leading blank lines only.
    const lead = "\n\n";
    const c = computeStamp({ ...shared, source: lead + canonicalBody, start: 2, end: 11 });

    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // And the canonical offsets index the heading in the canonical body.
    const src = a![Object.keys(a!).find((k) => k.endsWith("src"))!];
    expect(src.startsWith("0:9:")).toBe(true);
  });
});
