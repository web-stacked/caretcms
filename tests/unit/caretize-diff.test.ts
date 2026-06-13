import { describe, it, expect } from "vitest";
import { lineDiff, formatHunks } from "../../packages/caretize/src/diff";
import { formatDiff } from "../../packages/caretize/src/output";

describe("lineDiff", () => {
  it("marks an inserted line as +", () => {
    const d = lineDiff("a\nb", "a\nX\nb");
    expect(d).toEqual([
      { kind: " ", text: "a" },
      { kind: "+", text: "X" },
      { kind: " ", text: "b" },
    ]);
  });

  it("marks a changed line as - then +", () => {
    const d = lineDiff("import { x }", "import { x as xRaw }");
    expect(d).toEqual([
      { kind: "-", text: "import { x }" },
      { kind: "+", text: "import { x as xRaw }" },
    ]);
  });

  it("is all-context when nothing changed", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.kind === " ")).toBe(true);
  });
});

describe("formatHunks", () => {
  it("keeps changed lines plus context and collapses long unchanged runs", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "2", "3", "4", "CHANGED", "6", "7", "8"].join("\n");
    const out = formatHunks(lineDiff(before, after), 1);
    expect(out).toContain("+ CHANGED");
    expect(out).toContain("- 5");
    expect(out).toContain("…"); // distant unchanged lines collapsed
    expect(out).not.toContain("  1"); // line 1 is far from the change → dropped
  });

  it("returns empty string when there are no changes", () => {
    expect(formatHunks(lineDiff("a\nb", "a\nb"))).toBe("");
  });
});

describe("formatDiff", () => {
  it("renders a per-file hunk for each changed file, skipping no-ops", () => {
    const out = formatDiff([
      { relPath: "src/a.astro", source: "<h1>Hi</h1>", output: '<h1 data-caret="p::a::h">Hi</h1>', tagCount: 1, ok: true },
      { relPath: "src/b.astro", source: "<p>x</p>", output: "<p>x</p>", tagCount: 0, ok: true },
      { relPath: "src/c.astro", source: "bad", output: "bad!", tagCount: 1, ok: false },
    ]);
    expect(out).toContain("src/a.astro");
    expect(out).toContain('+ <h1 data-caret="p::a::h">Hi</h1>');
    expect(out).not.toContain("src/b.astro"); // no change
    expect(out).not.toContain("src/c.astro"); // failed verification → not previewed
  });

  it("says so when nothing would change", () => {
    expect(formatDiff([])).toBe("\n(no changes to preview)\n");
  });
});
