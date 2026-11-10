import { describe, expect, it } from "vitest";
import { matchEntry } from "../../packages/core/src/runtime/entry-search";

describe("matchEntry", () => {
  const mara = {
    name: "Mara Ellison",
    role: "Design director",
    bio: "Mara leads identity and editorial. She <strong class='accent'>draws letterforms</strong> for fun and once set a whole annual report in a typeface she cut herself.",
    links: [{ label: "Portfolio", href: "https://example.com" }],
    __body: "private overlay letterforms",
  };

  it("matches the id or title first", () => {
    expect(matchEntry("01-mara", mara, "mara")).toEqual({ kind: "title" });
    expect(matchEntry("01-mara", mara, "01-m")).toEqual({ kind: "title" });
  });

  it("finds text inside other fields, as readable text with a snippet", () => {
    const match = matchEntry("01-mara", mara, "letterforms");
    expect(match).toMatchObject({ kind: "field", field: "bio" });
    expect(match && match.kind === "field" && match.snippet).toBe(
      "…identity and editorial. She draws letterforms for fun and once set a whole annual…",
    );
  });

  it("does not match markup, only the text a reader sees", () => {
    expect(matchEntry("01-mara", mara, "accent")).toBeNull();
    expect(matchEntry("01-mara", mara, "strong")).toBeNull();
  });

  it("reports nested field paths", () => {
    expect(matchEntry("01-mara", mara, "portfolio")).toMatchObject({ kind: "field", field: "links.0.label", snippet: "Portfolio" });
  });

  it("skips private keys and decodes entities", () => {
    expect(matchEntry("x", { __body: "secret words" }, "secret")).toBeNull();
    expect(matchEntry("x", { text: "Fish &amp; chips" }, "fish & chips")).toMatchObject({ snippet: "Fish & chips" });
  });

  it("returns null when nothing matches", () => {
    expect(matchEntry("01-mara", mara, "zeppelin")).toBeNull();
  });
});
