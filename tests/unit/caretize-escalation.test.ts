import { describe, it, expect } from "vitest";
import {
  escalationCounts, totalOffer, deltaTags, mergeTagMaps, parseAnswer, parseToggle,
} from "../../packages/caretize/src/escalation";
import { formatEscalationOffer } from "../../packages/caretize/src/output";
import { planFile, type FilePlan, type PlannedTag } from "../../packages/caretize/src/plan";
import { applyKeyRegistry } from "../../packages/caretize/src/keys";
import type { CollectionBindTarget } from "../../packages/caretize/src/bind-collection";

const plan = (over: Partial<FilePlan> = {}): FilePlan =>
  ({ relPath: "f.astro", tags: [], skipped: [], flags: [], belowConfidence: 0, ...over } as unknown as FilePlan);

const tag = (startOffset: number, field = "x"): PlannedTag =>
  ({
    candidate: { tag: "p", kind: "text", rich: false, text: "t", startOffset },
    collection: "pages", id: "home", field,
    binding: `pages::home::${field}`, attribute: `data-caret="pages::home::${field}"`,
    startOffset, confidence: "high",
  } as unknown as PlannedTag);

describe("escalationCounts / totalOffer", () => {
  it("tallies rich-eligible skips, belowConfidence, and binds by kind", () => {
    const plans = [
      plan({ skipped: [{ reason: "rich-eligible" }, { reason: "rich-eligible" }] as unknown as FilePlan["skipped"], belowConfidence: 5 }),
      plan({ skipped: [{ reason: "inside-iterator" }] as unknown as FilePlan["skipped"], belowConfidence: 2 }),
    ];
    const binds = new Map<string, CollectionBindTarget[]>([
      ["a", [{ kind: "loop" }, { kind: "loop" }, { kind: "route" }] as unknown as CollectionBindTarget[]],
    ]);
    const c = escalationCounts(plans, binds);
    expect(c).toEqual({ collections: 2, routes: 1, rich: 2, lowconf: 7 });
    expect(totalOffer(c)).toBe(12);
  });

  it("totalOffer is 0 when there is nothing to offer", () => {
    expect(totalOffer(escalationCounts([plan()], new Map()))).toBe(0);
  });
});

describe("deltaTags", () => {
  it("returns only tags at offsets the conservative pass did not already have", () => {
    const cons = [plan({ tags: [tag(10), tag(20)] })];
    const final = [plan({ tags: [tag(10), tag(20), tag(30), tag(40)] })];
    const d = deltaTags(cons, final);
    expect(d.get("f.astro")?.map((t) => t.startOffset)).toEqual([30, 40]);
  });

  it("omits files with no new tags", () => {
    const same = [plan({ tags: [tag(10)] })];
    expect(deltaTags(same, same).size).toBe(0);
  });
});

describe("mergeTagMaps", () => {
  it("appends delta lists onto a copy without mutating the base", () => {
    const base = new Map([["f.astro", [tag(10)]]]);
    const delta = new Map([["f.astro", [tag(30)]], ["g.astro", [tag(5)]]]);
    const merged = mergeTagMaps(base, delta);
    expect(merged.get("f.astro")?.map((t) => t.startOffset)).toEqual([10, 30]);
    expect(merged.get("g.astro")?.map((t) => t.startOffset)).toEqual([5]);
    expect(base.get("f.astro")).toHaveLength(1); // base untouched
  });
});

describe("parseAnswer / parseToggle", () => {
  it("treats blank and y as yes, n as no, c as customize, else unknown", () => {
    expect(parseAnswer("")).toBe("yes");
    expect(parseAnswer("Y")).toBe("yes");
    expect(parseAnswer("yes")).toBe("yes");
    expect(parseAnswer("n")).toBe("no");
    expect(parseAnswer("c")).toBe("customize");
    expect(parseAnswer("customize")).toBe("customize");
    expect(parseAnswer("huh")).toBe("unknown");
  });
  it("toggle defaults to the recommendation on blank", () => {
    expect(parseToggle("", true)).toBe(true);
    expect(parseToggle("", false)).toBe(false);
    expect(parseToggle("y", false)).toBe(true);
    expect(parseToggle("n", true)).toBe(false);
  });
});

describe("formatEscalationOffer", () => {
  it("lists only non-zero tiers, in TIERS order, marking the per-row binders", () => {
    const out = formatEscalationOffer({ collections: 35, routes: 0, rich: 6, lowconf: 4 });
    expect(out).toContain("35 items in dynamic lists");
    expect(out).toContain("6 rich headings");
    expect(out).toContain("4 lower-confidence spots");
    expect(out).not.toContain("dynamic detail routes"); // 0 → omitted
    // collections is a guess tier → carries the ⚠ marker; rich does not
    expect(out).toMatch(/⚠ +35 items in dynamic lists/);
    expect(out).not.toMatch(/⚠ +6 rich headings/);
  });
  it("is empty when every count is zero", () => {
    expect(formatEscalationOffer({})).toBe("");
    expect(formatEscalationOffer({ collections: 0, rich: 0 })).toBe("");
  });
});

// The merge's load-bearing safety property: a field name a default tag and an
// escalation (rich) tag both derive must NOT collide into one storage key. This
// reproduces offerEscalation's conservative→rich→delta→merge→re-key sequence on
// a real file and asserts every resulting binding is unique.
describe("merge key safety (conservative + rich delta)", () => {
  const SRC = `---
---
<h1>Welcome</h1>
<p>Intro</p>
<p>Rich <strong>bold</strong> tail</p>
`;

  it("re-keying with defaults claimed first yields unique bindings", async () => {
    const cons = await planFile(SRC, "src/pages/index.astro", { minConfidence: "high" });
    const final = await planFile(SRC, "src/pages/index.astro", { minConfidence: "high", rich: true });
    // analyzeFiles runs the registry on each pass:
    applyKeyRegistry(SRC, cons.scope, cons.tags, [], []);
    applyKeyRegistry(SRC, final.scope, final.tags, [], []);

    // a rich delta exists (the mixed-content <p> only tags under --rich)
    const delta = deltaTags([cons], [final]);
    expect(delta.get("src/pages/index.astro")?.some((t) => t.candidate.rich)).toBe(true);

    // merge reviewed defaults + delta, then re-key with defaults first
    const merged = mergeTagMaps(
      new Map([["src/pages/index.astro", cons.tags]]),
      delta,
    );
    const tags = merged.get("src/pages/index.astro")!;
    applyKeyRegistry(SRC, cons.scope, tags, [], []);

    const bindings = tags.map((t) => t.binding);
    expect(new Set(bindings).size).toBe(bindings.length); // all unique — no dup key
    // the reviewed defaults kept their keys; the delta was deconflicted
    expect(bindings).toEqual(expect.arrayContaining(cons.tags.map((t) => t.binding)));
  });
});
