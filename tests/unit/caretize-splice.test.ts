import { describe, it, expect } from "vitest";
import {
  findOpenTagEnd,
  spliceAttribute,
} from "../../packages/caretize/src/splice";
import {
  parseAstro,
  walkTags,
  tagElementAndVerify,
  type TagNode,
} from "../../packages/caretize/src/parse";

/** Find the first tag with the given name, returning its byte start offset. */
async function firstTag(source: string, name: string): Promise<TagNode> {
  const ast = await parseAstro(source);
  let found: TagNode | undefined;
  walkTags(ast, (node) => {
    if (!found && node.name === name) found = node;
  });
  if (!found) throw new Error(`no <${name}> in source`);
  return found;
}

describe("findOpenTagEnd", () => {
  it("locates the > of a simple opening tag", () => {
    const buf = Buffer.from("<h1>hi</h1>", "utf8");
    const r = findOpenTagEnd(buf, 0)!;
    expect(r.selfClosing).toBe(false);
    expect(r.gtOffset).toBe(3);
    expect(r.insertAt).toBe(3); // before the >
  });

  it("handles self-closing tags, inserting before the slash", () => {
    const src = '<img src="/a.png" />';
    const buf = Buffer.from(src, "utf8");
    const r = findOpenTagEnd(buf, 0)!;
    expect(r.selfClosing).toBe(true);
    // insertAt sits before the `/`, so the result stays ` ... attr />`
    expect(src.slice(r.insertAt)).toBe("/>");
  });

  it("handles void elements with no slash", () => {
    const src = '<img src="/a.png">';
    const buf = Buffer.from(src, "utf8");
    const r = findOpenTagEnd(buf, 0)!;
    expect(r.selfClosing).toBe(false);
    expect(src.slice(r.insertAt)).toBe(">");
  });

  it("does not stop at a > inside a quoted attribute value", () => {
    const src = '<a data-x="a > b">link</a>';
    const buf = Buffer.from(src, "utf8");
    const r = findOpenTagEnd(buf, 0)!;
    // the real tag end is the LAST > (after the closing quote); the > at
    // index 13 is a decoy inside the quoted value and must be skipped.
    expect(r.gtOffset).toBe(src.lastIndexOf(">", src.indexOf("link")));
    expect(src[r.gtOffset]).toBe(">");
    expect(r.gtOffset).toBeGreaterThan(13);
  });

  it("does not stop at a > inside a {expression} attribute", () => {
    const src = "<a href={a > b ? x : y}>link</a>";
    const buf = Buffer.from(src, "utf8");
    const r = findOpenTagEnd(buf, 0)!;
    expect(src[r.gtOffset]).toBe(">");
    expect(src.slice(0, r.gtOffset)).toContain("? x : y");
  });

  it("returns null when the start offset is not a <", () => {
    const buf = Buffer.from("  <h1>hi</h1>", "utf8");
    expect(findOpenTagEnd(buf, 0)).toBeNull();
  });
});

describe("spliceAttribute reversibility", () => {
  it("is pure insertion — removing the inserted bytes restores the original", () => {
    const buf = Buffer.from("<h1>hi</h1>", "utf8");
    const attr = ' data-caret="pages::home::headline"';
    const out = spliceAttribute(buf, 3, attr);
    const attrLen = Buffer.byteLength(attr, "utf8");
    const restored = Buffer.concat([out.subarray(0, 3), out.subarray(3 + attrLen)]);
    expect(restored.equals(buf)).toBe(true);
    expect(out.toString("utf8")).toBe(
      '<h1 data-caret="pages::home::headline">hi</h1>',
    );
  });
});

describe("multibyte regression guard (THE byte-offset gotcha)", () => {
  // The compiler reports UTF-8 byte offsets. With a multibyte char before the
  // element, a string-index splice would land in the wrong place. This source
  // has an em-dash in a comment before the <h2>; the splice must still land
  // exactly on the <h2> opening tag.
  const source = [
    "---",
    "const x = 1;",
    "---",
    "<main>",
    "  <!-- intro — the dash here is multibyte -->",
    "  <h2>Headline</h2>",
    "</main>",
    "",
  ].join("\n");

  it("byte offset of <h2> diverges from its UTF-16 string index", async () => {
    const h2 = await firstTag(source, "h2");
    const byteOffset = h2.position!.start.offset;
    const stringIndex = source.indexOf("<h2>");
    // proof the hazard is real in this fixture: the two are NOT equal
    expect(byteOffset).not.toBe(stringIndex);
    // and the byte offset, read on a Buffer, points at the '<' of <h2>
    const buf = Buffer.from(source, "utf8");
    expect(buf.subarray(byteOffset, byteOffset + 4).toString("utf8")).toBe("<h2>");
  });

  it("tags the correct element despite the preceding multibyte char", async () => {
    const h2 = await firstTag(source, "h2");
    const res = await tagElementAndVerify(
      source,
      { name: "h2", startOffset: h2.position!.start.offset },
      'data-caret="pages::home::headline"',
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain(
      '<h2 data-caret="pages::home::headline">Headline</h2>',
    );
    // the em-dash comment is untouched
    expect(res.output).toContain("intro — the dash here is multibyte");
  });
});

describe("tagElementAndVerify", () => {
  it("round-trips a valid splice and reports ok", async () => {
    const source = "<main>\n  <h1>Welcome</h1>\n</main>\n";
    const h1 = await firstTag(source, "h1");
    const res = await tagElementAndVerify(
      source,
      { name: "h1", startOffset: h1.position!.start.offset },
      'data-caret="pages::home::headline"',
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain(
      '<h1 data-caret="pages::home::headline">Welcome</h1>',
    );
  });

  it("rejects (does not corrupt) when the offset is not an opening tag", async () => {
    const source = "<main>\n  <h1>Welcome</h1>\n</main>\n";
    const res = await tagElementAndVerify(
      source,
      { name: "h1", startOffset: 1 /* points inside <main, not at a tag start */ },
      'data-caret="x::y::z"',
    );
    expect(res.ok).toBe(false);
    expect(res.output).toBe(source); // unchanged
  });
});
