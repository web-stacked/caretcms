import { describe, expect, it } from "vitest";
import {
  historyChanges,
  historyFieldLabel,
  historyValueText,
  relativeTime,
  wordDiff,
} from "../../packages/core/static/cms/studio/history-view.js";

const schema = {
  type: "object",
  properties: {
    eyebrow: { type: "string", title: "Intro label" },
    intro: { type: "string", title: "Introduction", format: "html" },
    cover: { type: "string", title: "Cover image" },
    team: {
      type: "array",
      title: "Team",
      items: { type: "object", properties: { name: { type: "string", title: "Name" } } },
    },
  },
};

describe("historyChanges", () => {
  it("lists only the fields a change touched, with form labels and readable values", () => {
    const before = { eyebrow: "Studio of two", intro: "<p>We make <strong>calm</strong> brands.</p>", cover: "/uploads/a.jpg" };
    const after = { eyebrow: "Studio of two", intro: "<p>We make durable brands &amp; sites.</p>", cover: "/uploads/b.jpg?v=2" };
    expect(historyChanges(before, after, schema, "Empty")).toMatchObject([
      { path: "intro", label: "Introduction", before: "We make calm brands.", after: "We make durable brands & sites." },
      { path: "cover", label: "Cover image", before: "a.jpg", after: "b.jpg" },
    ]);
  });

  it("walks into list items and labels them by position", () => {
    const before = { team: [{ name: "Mara" }, { name: "Idris" }] };
    const after = { team: [{ name: "Mara" }, { name: "Idris Vance" }] };
    expect(historyChanges(before, after, schema, "Empty")).toMatchObject([
      { path: "team.1.name", label: "Team › #2 › Name", before: "Idris", after: "Idris Vance" },
    ]);
  });

  it("summarizes a list that gained or lost items", () => {
    expect(historyChanges({ team: [{ name: "A" }] }, { team: [{ name: "A" }, { name: "B" }] }, schema, "Empty"))
      .toMatchObject([{ path: "team", label: "Team", before: "1 item", after: "2 items" }]);
  });

  it("shows added and cleared fields as empty, and skips private keys", () => {
    expect(historyChanges({ __body: "x" }, { eyebrow: "New", __body: "y" }, schema, "Empty"))
      .toMatchObject([{ path: "eyebrow", label: "Intro label", before: "Empty", after: "New" }]);
    expect(historyChanges({ eyebrow: "Old" }, { eyebrow: "" }, schema, "Empty"))
      .toMatchObject([{ path: "eyebrow", label: "Intro label", before: "Old", after: "Empty" }]);
  });

  it("finds nothing when versions match", () => {
    expect(historyChanges({ eyebrow: "Same" }, { eyebrow: "Same" }, schema, "Empty")).toMatchObject([]);
  });
});

describe("history formatting", () => {
  it("falls back to humanized keys without a schema title", () => {
    expect(historyFieldLabel("cta_label", schema)).toBe("Call to action label");
    expect(historyFieldLabel("eyebrow", null)).toBe("Eyebrow");
  });

  it("shortens long text and formats non-text values", () => {
    expect(historyValueText("x".repeat(120), "Empty")).toHaveLength(80);
    expect(historyValueText(true, "Empty")).toBe("Yes");
    expect(historyValueText(undefined, "Empty")).toBe("Empty");
    expect(historyValueText("<p> </p>", "Empty")).toBe("Empty");
  });

  it("says when relative to now, and the date after a week", () => {
    const now = Date.UTC(2026, 9, 23, 12);
    expect(relativeTime(now - 10_000, now, "en")).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(relativeTime(now - 3 * 3_600_000, now, "en")).toBe("3 hours ago");
    expect(relativeTime(now - 24 * 3_600_000, now, "en")).toBe("yesterday");
    expect(relativeTime(now - 30 * 86_400_000, now, "en")).toBe("Sep 23, 2026");
  });
});

describe("wordDiff", () => {
  it("marks only the words that changed", () => {
    expect(wordDiff(
      "We make calm, durable brands for ambitious teams.",
      "We make calm, durable brands for ambitious Truly.teams.",
    )).toEqual([
      { op: "=", text: "…calm, durable brands for ambitious " },
      { op: "-", text: "teams." },
      { op: "+", text: "Truly.teams." },
    ]);
  });

  it("shortens long unchanged stretches to a few words around each change", () => {
    const before = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    const after = "one two three four five six seven EIGHT nine ten eleven twelve thirteen fourteen";
    expect(wordDiff(before, after)).toEqual([
      { op: "=", text: "…three four five six seven " },
      { op: "-", text: "eight" },
      { op: "+", text: "EIGHT" },
      { op: "=", text: " nine ten eleven twelve thirteen…" },
    ]);
  });

  it("gives up on a rewrite, which reads better as before → after", () => {
    expect(wordDiff("Calm brands for teams", "Bold sites, shipped weekly by people")).toBeNull();
  });

  it("is attached to text changes and not to images", () => {
    const [text, image] = historyChanges(
      { intro: "We make calm brands.", cover: "/uploads/a.jpg" },
      { intro: "We make bold brands.", cover: "/uploads/b.jpg" },
      schema,
      "Empty",
    );
    expect(text.diff).toEqual([
      { op: "=", text: "We make " },
      { op: "-", text: "calm" },
      { op: "+", text: "bold" },
      { op: "=", text: " brands." },
    ]);
    expect(image.diff).toBeNull();
  });
});
