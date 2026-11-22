import { describe, expect, it } from "vitest";
import { keepWrittenQuotes, spliceBodyBlocks } from "../../packages/core/src/markdown/splice";
import { fnv1a32 } from "../../packages/core/src/markdown/contracts";

describe("keepWrittenQuotes", () => {
  it("puts straight quotes back when the author wrote straight ones", () => {
    expect(keepWrittenQuotes(`> "It's fine." Twice`, "> “It’s fine.” Twice, again")).toBe(`> "It's fine." Twice, again`);
  });

  it("leaves curly quotes alone when the author wrote curly ones", () => {
    expect(keepWrittenQuotes("She said “hi”.", "She said “hello”.")).toBe("She said “hello”.");
  });

  it("leaves text with no quotes in its source alone, so an editor can add some", () => {
    expect(keepWrittenQuotes("No quotes here.", "Now “quoted”.")).toBe("Now “quoted”.");
  });
});

describe("spliceBodyBlocks keeps the quotes the file was written with", () => {
  it("splices an edited paragraph without curling its quotes", () => {
    const file = `---\ntitle: T\n---\n\nIt's a "test" paragraph.\n\nSecond.\n`;
    const text = `It's a "test" paragraph.`;
    const start = file.indexOf(text) - file.indexOf("It's");
    const body = file.slice(file.indexOf("It's"));
    const src = { start: 0, end: text.length, hash: fnv1a32(body.slice(0, text.length)) };
    expect(start).toBe(0);
    const result = spliceBodyBlocks(file, [{ md: "It’s a “test” paragraph, edited.", src }]);
    expect(result.ok && result.content).toBe(`---\ntitle: T\n---\n\nIt's a "test" paragraph, edited.\n\nSecond.\n`);
  });
});
