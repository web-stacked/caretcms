import { describe, expect, it } from "vitest";
import { parseParagraphSources } from "../../packages/core/static/cms/editor/md-block-edit.js";

describe("Markdown browser controller boundaries", () => {
  it("accepts a valid consecutive paragraph source list", () => {
    const sources = [
      { blockPath: "4", src: "10:20:1234abcd", html: "First" },
      { blockPath: "5", src: "22:30:90abcdef", html: "Second" },
    ];

    expect(parseParagraphSources(JSON.stringify(sources))).toEqual(sources);
  });

  it("rejects malformed JSON and non-array source data", () => {
    expect(parseParagraphSources("{")).toBeNull();
    expect(parseParagraphSources(JSON.stringify({ blockPath: "4" }))).toBeNull();
    expect(parseParagraphSources("[]")).toBeNull();
  });

  it("rejects invalid source hints and nonconsecutive paragraph paths", () => {
    expect(parseParagraphSources(JSON.stringify([
      { blockPath: "4", src: "20:10:1234abcd", html: "First" },
    ]))).toBeNull();
    expect(parseParagraphSources(JSON.stringify([
      { blockPath: "4", src: "10:20:1234abcd", html: "First" },
      { blockPath: "6", src: "22:30:90abcdef", html: "Second" },
    ]))).toBeNull();
  });

  it("enforces the server's 128-source limit", () => {
    const sources = Array.from({ length: 129 }, (_, index) => ({
      blockPath: String(index),
      src: `${index * 2}:${index * 2 + 1}:1234abcd`,
      html: `Paragraph ${index}`,
    }));

    expect(parseParagraphSources(JSON.stringify(sources))).toBeNull();
  });
});
