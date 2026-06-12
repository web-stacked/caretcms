import { describe, it, expect } from "vitest";
import { parseArgs, CliUsageError, HELP } from "../../packages/caretize/src/cli-args";

describe("parseArgs", () => {
  it("defaults to a safe high-confidence, write-nothing-yet config", () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({
      dryRun: false, yes: false, minConfidence: "high",
      noImages: false, rich: false, noProps: false, restore: false, help: false, version: false,
    });
    expect(a.target).toBeUndefined();
  });

  it("parses the boolean flags (long + short forms)", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["-y"]).yes).toBe(true);
    expect(parseArgs(["--yes"]).yes).toBe(true);
    expect(parseArgs(["--no-images"]).noImages).toBe(true);
    expect(parseArgs(["--no-props"]).noProps).toBe(true);
    expect(parseArgs(["--bind-collections"]).bindCollections).toBe(true);
    expect(parseArgs([]).bindCollections).toBe(false);
    expect(parseArgs(["--rich"]).rich).toBe(true);
    expect(parseArgs(["--restore"]).restore).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("takes a positional path as the scan target", () => {
    expect(parseArgs(["src/pages/about.astro"]).target).toBe("src/pages/about.astro");
  });

  it("parses --min-confidence and rejects bad levels", () => {
    expect(parseArgs(["--min-confidence", "low"]).minConfidence).toBe("low");
    expect(parseArgs(["--min-confidence", "medium"]).minConfidence).toBe("medium");
    expect(() => parseArgs(["--min-confidence", "bogus"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--min-confidence"])).toThrow(/high\|medium\|low/);
  });

  it("parses --scope into collection::id and rejects malformed values", () => {
    expect(parseArgs(["--scope", "blog::intro"]).scope).toEqual({ collection: "blog", id: "intro" });
    expect(() => parseArgs(["--scope", "nope"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--scope", "::"])).toThrow(/collection::id/);
  });

  it("rejects --scope labels the runtime would reject", () => {
    // Uppercase saves lowercase but renders verbatim — a binding that only
    // "works" on case-insensitive dev filesystems. Refuse it up front.
    expect(() => parseArgs(["--scope", "Pages::Home"])).toThrow(/\[a-z\]/);
    expect(() => parseArgs(["--scope", "pages::My Page"])).toThrow(CliUsageError);
    expect(parseArgs(["--scope", "pages::my-page_2"]).scope).toEqual({
      collection: "pages",
      id: "my-page_2",
    });
  });

  it("captures --report's file argument", () => {
    expect(parseArgs(["--report", "out.json"]).report).toBe("out.json");
  });

  it("refuses --report without a file path (a following flag is not one)", () => {
    expect(() => parseArgs(["--report"])).toThrow(/file path/);
    // Used to swallow the next flag as the filename and silently skip dry-run.
    expect(() => parseArgs(["--report", "--dry-run"])).toThrow(/file path/);
  });

  it("rejects an unknown flag with a CliUsageError naming it", () => {
    expect(() => parseArgs(["--wat"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--wat"])).toThrow(/unknown flag: --wat/);
  });

  it("combines flags and a target", () => {
    const a = parseArgs(["--rich", "-y", "--min-confidence", "medium", "src"]);
    expect(a).toMatchObject({ rich: true, yes: true, minConfidence: "medium", target: "src" });
  });
});

describe("HELP", () => {
  it("documents usage and the headline flags", () => {
    expect(HELP).toContain("Usage: caretize");
    expect(HELP).toContain("--dry-run");
    expect(HELP).toContain("--min-confidence");
    expect(HELP).toContain("--restore");
  });
});
