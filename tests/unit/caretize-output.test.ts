import { describe, it, expect } from "vitest";
import {
  tagLine, formatScanSummary, formatPlan, formatSummary, formatHints, formatFailures, formatNextStep,
} from "../../packages/caretize/src/output";
import type { Preflight } from "../../packages/caretize/src/preflight";
import type { FilePlan, PlannedTag } from "../../packages/caretize/src/plan";
import type { WrapTarget } from "../../packages/caretize/src/wrap";
import type { PropHoistTarget } from "../../packages/caretize/src/prop-hoist";
import type { CollectionBindTarget } from "../../packages/caretize/src/bind-collection";

function tag(over: Partial<PlannedTag> & { candidate?: Partial<PlannedTag["candidate"]> } = {}): PlannedTag {
  return {
    candidate: { tag: "h1", kind: "text", rich: false, text: "Hello world", ...over.candidate },
    collection: "pages", id: "home", field: "headline",
    binding: "pages::home::headline", attribute: 'data-caret="pages::home::headline"',
    startOffset: 0, confidence: "high", ...over,
  } as unknown as PlannedTag;
}

function plan(over: Partial<FilePlan> = {}): FilePlan {
  return { relPath: "src/pages/index.astro", tags: [], skipped: [], flags: [], ...over } as unknown as FilePlan;
}

const wrap = (over: Partial<WrapTarget> = {}): WrapTarget =>
  ({ origin: "const", key: "pages::home::faqs", varName: "faqs", ...over } as unknown as WrapTarget);

const hoist = (over: Partial<PropHoistTarget> = {}): PropHoistTarget =>
  ({
    componentName: "Hero",
    props: [{ key: "pages::home::title", propName: "title", isRich: false, literalValue: "Welcome", constName: "title" }],
    ...over,
  } as unknown as PropHoistTarget);

describe("tagLine", () => {
  it("renders a text candidate as a quoted snippet", () => {
    expect(tagLine(tag())).toBe('<h1> "Hello world"');
  });
  it("renders an image candidate as src=", () => {
    expect(tagLine(tag({ candidate: { tag: "img", kind: "image", rich: false, text: "/a.png" } }))).toBe('<img> src="/a.png"');
  });
  it("marks rich candidates and collapses whitespace", () => {
    expect(tagLine(tag({ candidate: { tag: "p", kind: "text", rich: true, text: "a\n  b" } }))).toBe('<p> [rich] "a b"');
  });
});

describe("formatScanSummary", () => {
  it("tallies candidates, wraps, and props across files", () => {
    const plans = [plan({ tags: [tag(), tag()] })];
    const wraps = new Map([["f", [wrap(), wrap()]]]);
    const hoists = new Map([["f", [hoist()]]]);
    expect(formatScanSummary(3, plans, wraps, hoists))
      .toBe("✓ 3 .astro files · 2 tag candidate(s) · 2 wrap target(s) · 1 prop(s)\n");
  });

  it("frames a re-run as new + already-editable when priorTagged > 0", () => {
    const out = formatScanSummary(3, [plan({ tags: [tag()] })], new Map(), new Map(), new Map(), 8);
    expect(out).toContain("1 new tag candidate(s)");
    expect(out).toContain("8 already editable");
  });
});

describe("formatNextStep", () => {
  const pf = (over: Partial<Preflight>): Preflight =>
    ({ isAstroProject: true, hasCaretCore: true, caretWired: true, outputMode: "server",
       gitRepo: true, gitClean: true, errors: [], warnings: [], ...over } as Preflight);

  it("tells an un-installed project to install + wire core", () => {
    expect(formatNextStep(pf({ hasCaretCore: false }))).toContain("npm i @caretcms/core");
  });
  it("tells an installed-but-unwired project to add caret()", () => {
    const out = formatNextStep(pf({ caretWired: false }));
    expect(out).toContain("caret()");
    expect(out).not.toContain("npm i");
  });
  it("tells a static-output project to switch to server", () => {
    expect(formatNextStep(pf({ outputMode: "static" }))).toContain('output: "server"');
  });
  it("tells a fully-wired project to run dev and click to edit", () => {
    expect(formatNextStep(pf({}))).toBe("Next: npm run dev → open your page → click to edit\n");
  });
});

describe("formatPlan", () => {
  it("lists tags, wraps, hoists, and loop flags, then a footer", () => {
    const plans = [plan({
      tags: [tag()],
      flags: [{ method: "map", startOffset: 0 } as unknown as FilePlan["flags"][number]],
    })];
    const wraps = new Map([["src/pages/index.astro", [wrap({ origin: "import", varName: "faqs", key: "k" })]]]);
    const hoists = new Map([["src/pages/index.astro", [hoist()]]]);
    const out = formatPlan(plans, wraps, hoists);
    expect(out).toContain('+ data-caret="pages::home::headline"');
    expect(out).toContain('~ editable("k")  wrap import faqs (via data import)');
    expect(out).toContain('⤴ editable("pages::home::title")  hoist <Hero> title');
    expect(out).toContain("⚠ map() loop — consider a dynamic collection");
    expect(out).toContain("(dry run — nothing written)");
  });

  it("skips files with nothing to show", () => {
    expect(formatPlan([plan()], new Map(), new Map())).toBe("\n(dry run — nothing written)\n");
  });

  it("labels collection-loop and route binds distinctly", () => {
    const binds = new Map<string, CollectionBindTarget[]>([
      ["src/pages/index.astro", [
        { startOffset: 0, attribute: "x", collection: "blog", field: "title", tag: "h2", receiver: "posts", kind: "loop" },
        { startOffset: 1, attribute: "y", collection: "blog", field: "title", tag: "h1", receiver: "entry", kind: "route" },
      ]],
    ]);
    const out = formatPlan([plan({ tags: [tag()] })], new Map(), new Map(), binds);
    expect(out).toContain("⟳ data-caret  bind <h2> blog::*::title  (per-row collection loop)");
    expect(out).toContain("⟳ data-caret  bind <h1> blog::${entry}::title  (current entry)");
  });
});

describe("formatSummary", () => {
  it("shows only the lines with non-zero counts", () => {
    const out = formatSummary(2, 5, 0, 0, 0, false);
    expect(out).toContain("✓ 5 change(s) across 2 file(s)");
    expect(out).not.toContain("wrapped with editable");
    expect(out).not.toContain("backups in");
  });
  it("adds wrap/hoist/flag/backup lines when present", () => {
    const out = formatSummary(1, 1, 2, 3, 4, true);
    expect(out).toContain("✓ 2 data array(s) wrapped with editable()");
    expect(out).toContain("✓ 3 component prop(s) hoisted to editable()");
    expect(out).toContain("⚠ 4 loop(s) flagged");
    expect(out).toContain("⤺ backups in .caret/.caretize-bak/");
  });
});

describe("formatHints", () => {
  it("rolls remaining coverage into one line pointing at --all", () => {
    const plans = [plan({
      skipped: [{ reason: "rich-eligible" }, { reason: "inside-iterator" }] as unknown as FilePlan["skipped"],
      belowConfidence: 4,
    })];
    const out = formatHints(plans, {});
    expect(out).toContain("More can be made editable:");
    expect(out).toContain("1 rich heading(s)");
    expect(out).toContain("1 item(s) in dynamic lists");
    expect(out).toContain("4 lower-confidence spot(s)");
    expect(out).toContain("Re-run with --all");
  });

  it("omits a tier from the line once that tier is on", () => {
    const plans = [plan({ skipped: [{ reason: "rich-eligible" }] as unknown as FilePlan["skipped"] })];
    expect(formatHints(plans, {})).toContain("rich heading(s)");
    expect(formatHints(plans, { rich: true })).toBe("");
  });

  it("suppresses each tier under its own flag", () => {
    const iter = [plan({ skipped: [{ reason: "inside-iterator" }] as unknown as FilePlan["skipped"] })];
    expect(formatHints(iter, {})).toContain("--all");
    expect(formatHints(iter, { collections: true })).toBe("");

    const route = [plan({ scopeSkip: "dynamic-route" })];
    expect(formatHints(route, {})).toContain("dynamic detail route(s)");
    expect(formatHints(route, { routes: true })).toBe("");

    const low = [plan({ belowConfidence: 3 })];
    expect(formatHints(low, {})).toContain("lower-confidence spot(s)");
    expect(formatHints(low, { lowconf: true })).toBe("");
  });

  it("flags styled-inline blocks separately (not unlocked by a tier flag)", () => {
    const plans = [plan({ skipped: [{ reason: "rich-unsafe-attrs" }] as unknown as FilePlan["skipped"] })];
    // Present even when every tier is on — it needs a CSS move, not a flag.
    const out = formatHints(plans, { rich: true, collections: true, routes: true, lowconf: true });
    expect(out).toContain("allowedClasses");
    expect(out).not.toContain("More can be made editable");
  });

  it("names the exact tag+class to bless in the allowedClasses hint", () => {
    // Host block whose inline children carry classes the sanitizer strips.
    const host = {
      type: "element",
      name: "p",
      attributes: [],
      children: [
        { type: "element", name: "strong", attributes: [{ name: "class", value: "hl big" }], children: [] },
        { type: "element", name: "a", attributes: [{ name: "class", value: "gold" }], children: [] },
      ],
    };
    const plans = [
      plan({ skipped: [{ reason: "rich-unsafe-attrs", node: host }] as unknown as FilePlan["skipped"] }),
    ];
    const out = formatHints(plans, {});
    // Concrete, copy-pasteable — alphabetized by tag, classes sorted & deduped.
    expect(out).toContain(`allowedClasses: { a: ["gold"], strong: ["big", "hl"] }`);
    expect(out).not.toContain(`["your-class"]`);
  });

  it("falls back to the generic snippet when the skip carries no node", () => {
    const plans = [plan({ skipped: [{ reason: "rich-unsafe-attrs" }] as unknown as FilePlan["skipped"] })];
    expect(formatHints(plans, {})).toContain(`{ tag: ["your-class"] }`);
  });

  it("nudges --rich-class + names classes for rich-class-promotable skips (pre-tag)", () => {
    const host = {
      type: "element", name: "h1", attributes: [],
      children: [{ type: "element", name: "span", attributes: [{ name: "class", value: "gold" }], children: [] }],
    };
    const plans = [
      plan({ skipped: [{ reason: "rich-class-promotable", node: host }] as unknown as FilePlan["skipped"] }),
    ];
    const out = formatHints(plans, {}); // richClass off
    expect(out).toContain("--rich-class");
    expect(out).toContain(`allowedClasses: { span: ["gold"] }`);
  });

  it("reminds to bless classes after tagging styled-span blocks (post-apply)", () => {
    const richNode = {
      type: "element", name: "h1", attributes: [],
      children: [{ type: "element", name: "span", attributes: [{ name: "class", value: "gold" }], children: [] }],
    };
    const tagged = { candidate: { tag: "h1", rich: true, node: richNode } };
    const plans = [plan({ tags: [tagged] as unknown as FilePlan["tags"] })];
    const out = formatHints(plans, { richClass: true }); // richClass on → post-apply reminder
    expect(out).toContain("Tagged styled-span");
    expect(out).toContain(`allowedClasses: { span: ["gold"] }`);
  });

  it("says nothing when there is nothing to hint", () => {
    expect(formatHints([plan()], {})).toBe("");
  });
});

describe("formatFailures", () => {
  it("names each would-fail file with its reason", () => {
    const out = formatFailures([
      { relPath: "a.astro", ok: true },
      { relPath: "b.astro", ok: false, reason: "could not place 1 tag(s)" },
    ]);
    expect(out).toContain("✗ b.astro would fail verification: could not place 1 tag(s)");
    expect(out).not.toContain("a.astro");
  });
  it("is silent when everything verifies", () => {
    expect(formatFailures([{ relPath: "a.astro", ok: true }])).toBe("");
  });
});
