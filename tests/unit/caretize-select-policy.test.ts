import { describe, it, expect } from "vitest";
import { TIERS, tierById, type TierId } from "../../packages/caretize/src/tiers";
import { selectTiers, recommendedTiers } from "../../packages/caretize/src/select-policy";

const ids = (s: Set<TierId>) => [...s].sort();

describe("TIERS descriptor table", () => {
  it("covers exactly the five escalation tiers", () => {
    expect(TIERS.map((t) => t.id).sort()).toEqual([
      "collections", "lowconf", "rich", "rich-class", "routes",
    ]);
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

  it("--all selects every tier, including lowconf and rich-class", () => {
    expect(ids(selectTiers({ all: true }))).toEqual([
      "collections", "lowconf", "rich", "rich-class", "routes",
    ]);
  });

  it("--all overrides absent individual flags", () => {
    expect(ids(selectTiers({ all: true, flags: { rich: false } }))).toEqual([
      "collections", "lowconf", "rich", "rich-class", "routes",
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

  it("prompt 'yes' selects the recommended bundle (no lowconf)", () => {
    expect(ids(selectTiers({ promptAnswer: "yes" }))).toEqual(["collections", "rich", "routes"]);
  });

  it("prompt 'no' selects nothing", () => {
    expect(ids(selectTiers({ promptAnswer: "no" }))).toEqual([]);
  });

  it("prompt with a custom id list selects exactly those", () => {
    expect(ids(selectTiers({ promptAnswer: ["rich", "lowconf"] }))).toEqual(["lowconf", "rich"]);
  });

  it("--all still wins over a prompt answer", () => {
    expect(ids(selectTiers({ all: true, promptAnswer: "no" }))).toEqual([
      "collections", "lowconf", "rich", "rich-class", "routes",
    ]);
  });

  it("returns a fresh set each call (no shared mutable state)", () => {
    const a = selectTiers({ all: true });
    a.delete("rich");
    expect(selectTiers({ all: true }).has("rich")).toBe(true);
  });
});
