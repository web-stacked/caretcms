import { describe, it, expect } from "vitest";
import { TIERS, tierById, type TierId } from "../../packages/caretize/src/tiers";
import { selectTiers, recommendedTiers } from "../../packages/caretize/src/select-policy";

const ids = (s: Set<TierId>) => [...s].sort();

describe("TIERS descriptor table", () => {
  it("covers exactly the four escalation tiers", () => {
    expect(TIERS.map((t) => t.id).sort()).toEqual(["collections", "lowconf", "rich", "routes"]);
  });
  it("marks the per-row binders as guesses and the rest as judgment", () => {
    expect(tierById("collections").risk).toBe("guess");
    expect(tierById("routes").risk).toBe("guess");
    expect(tierById("rich").risk).toBe("judgment");
    expect(tierById("lowconf").risk).toBe("judgment");
  });
  it("recommends collections/routes/rich but not lowconf", () => {
    expect(ids(recommendedTiers())).toEqual(["collections", "rich", "routes"]);
  });
  it("throws on an unknown id", () => {
    expect(() => tierById("nope" as TierId)).toThrow(/unknown tier/);
  });
});

describe("selectTiers", () => {
  it("default (no intent) selects nothing — the conservative set", () => {
    expect(ids(selectTiers({}))).toEqual([]);
    expect(ids(selectTiers({ flags: {} }))).toEqual([]);
  });

  it("--all selects every tier, including lowconf", () => {
    expect(ids(selectTiers({ all: true }))).toEqual(["collections", "lowconf", "rich", "routes"]);
  });

  it("--all overrides absent individual flags", () => {
    expect(ids(selectTiers({ all: true, flags: { rich: false } }))).toEqual([
      "collections", "lowconf", "rich", "routes",
    ]);
  });

  it("individual flags select exactly those tiers", () => {
    expect(ids(selectTiers({ flags: { rich: true } }))).toEqual(["rich"]);
    expect(ids(selectTiers({ flags: { collections: true, routes: true } }))).toEqual([
      "collections", "routes",
    ]);
  });

  it("a false flag does not select its tier", () => {
    expect(ids(selectTiers({ flags: { rich: true, lowconf: false } }))).toEqual(["rich"]);
  });

  it("returns a fresh set each call (no shared mutable state)", () => {
    const a = selectTiers({ all: true });
    a.delete("rich");
    expect(selectTiers({ all: true }).has("rich")).toBe(true);
  });
});
