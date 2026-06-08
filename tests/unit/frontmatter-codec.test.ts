import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseFrontmatter,
  serializeFrontmatter,
} from "../../packages/core/src/runtime/storage/frontmatter-codec";

/** Compose a full file the way the markdown adapter does, for round-trip checks. */
function compose(data: Record<string, unknown>, body: string): string {
  const ser = serializeFrontmatter(data);
  if (!ser.ok) throw new Error(`serialize failed: ${ser.reason}`);
  return `---\n${ser.content}---\n${body}`;
}

describe("parseFrontmatter", () => {
  it("returns empty data + bodyStart 0 when there is no frontmatter", () => {
    const r = parseFrontmatter("# Just markdown\n");
    expect(r).toEqual({ ok: true, data: {}, bodyStart: 0 });
  });

  it("parses flat scalars with their JS types", () => {
    const src = `---
title: Hello World
count: 42
ratio: 3.14
draft: false
flagged: true
missing: null
---
body`;
    const r = parseFrontmatter(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      title: "Hello World",
      count: 42,
      ratio: 3.14,
      draft: false,
      flagged: true,
      missing: null,
    });
  });

  it("parses nested mappings", () => {
    const src = `---
seo:
  title: SEO Title
  description: A description
---
`;
    const r = parseFrontmatter(src);
    expect(r.ok && r.data).toEqual({ seo: { title: "SEO Title", description: "A description" } });
  });

  it("parses block sequences of scalars", () => {
    const src = `---
tags:
  - astro
  - cms
---
`;
    const r = parseFrontmatter(src);
    expect(r.ok && r.data).toEqual({ tags: ["astro", "cms"] });
  });

  it("parses sequences of mappings (arrays of objects)", () => {
    const src = `---
authors:
  - name: Ada
    role: writer
  - name: Bob
    role: editor
---
`;
    const r = parseFrontmatter(src);
    expect(r.ok && r.data).toEqual({
      authors: [
        { name: "Ada", role: "writer" },
        { name: "Bob", role: "editor" },
      ],
    });
  });

  it("parses inline flow collections", () => {
    const r = parseFrontmatter(`---\ntags: [a, b, c]\nmeta: {x: 1, y: 2}\nempty: []\n---\n`);
    expect(r.ok && r.data).toEqual({ tags: ["a", "b", "c"], meta: { x: 1, y: 2 }, empty: [] });
  });

  it("strips trailing comments but not '#' inside quotes", () => {
    const r = parseFrontmatter(`---\ntitle: Hello # a comment\ncolor: "#ff0000"\n---\n`);
    expect(r.ok && r.data).toEqual({ title: "Hello", color: "#ff0000" });
  });

  it("computes bodyStart at the first byte after the closing fence", () => {
    const src = `---\ntitle: x\n---\nThe body starts here`;
    const r = parseFrontmatter(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(src.slice(r.bodyStart)).toBe("The body starts here");
  });

  it("treats YAML 1.1 boolean spellings as booleans", () => {
    const r = parseFrontmatter(`---\na: yes\nb: no\nc: on\nd: off\n---\n`);
    expect(r.ok && r.data).toEqual({ a: true, b: false, c: true, d: false });
  });

  it("fails loud on block scalars", () => {
    const r = parseFrontmatter(`---\nbody: |\n  line one\n  line two\n---\n`);
    expect(r.ok).toBe(false);
  });

  it("fails loud on block-scalar chomping/indent variants (|-, >+, |2)", () => {
    for (const header of ["|-", "|+", ">-", ">+", "|2", ">2-"]) {
      const r = parseFrontmatter(`---\ndescription: ${header}\n  multi line\n  body here\n---\n`);
      expect(r.ok, `header ${header} should fail loud`).toBe(false);
    }
  });

  it("does not mistake a plain string that merely starts with | or > for a block scalar", () => {
    const r = parseFrontmatter(`---\nformula: "|x| > 3"\n---\n`);
    expect(r.ok && r.data).toEqual({ formula: "|x| > 3" });
  });

  it("handles CRLF line endings and preserves a CRLF body", () => {
    const body = "# Heading\r\n\r\nParagraph.\r\n";
    const r = parseFrontmatter(`---\r\ntitle: x\r\n---\r\n${body}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ title: "x" });
    expect(`---\r\ntitle: x\r\n---\r\n${body}`.slice(r.bodyStart)).toBe(body);
  });

  it("fails loud on anchors/aliases", () => {
    expect(parseFrontmatter(`---\na: &anchor value\nb: *anchor\n---\n`).ok).toBe(false);
  });

  it("fails loud on tab indentation", () => {
    expect(parseFrontmatter("---\nseo:\n\ttitle: x\n---\n").ok).toBe(false);
  });
});

describe("serializeFrontmatter", () => {
  it("emits an empty string for an empty record", () => {
    expect(serializeFrontmatter({})).toEqual({ ok: true, content: "" });
  });

  it("quotes strings that would otherwise parse as non-strings", () => {
    const r = serializeFrontmatter({ a: "123", b: "true", c: "null", d: "yes" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Each must come back as the original string, not a number/bool/null.
    const parsed = parseFrontmatter(`---\n${r.content}---\n`);
    expect(parsed.ok && parsed.data).toEqual({ a: "123", b: "true", c: "null", d: "yes" });
  });

  it("rejects non-finite numbers", () => {
    expect(serializeFrontmatter({ n: Infinity }).ok).toBe(false);
    expect(serializeFrontmatter({ n: NaN }).ok).toBe(false);
  });

  it("rejects unsupported value types", () => {
    expect(serializeFrontmatter({ when: new Date() as unknown }).ok).toBe(false);
    expect(serializeFrontmatter({ fn: (() => 1) as unknown }).ok).toBe(false);
  });

  it("does not preserve comments (documented v1 behavior)", () => {
    const src = `---\ntitle: x # keep me?\n---\nbody`;
    const parsed = parseFrontmatter(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ser = serializeFrontmatter(parsed.data);
    expect(ser.ok && ser.content.includes("#")).toBe(false);
  });
});

describe("body preservation", () => {
  it("keeps the body byte-identical across a parse → serialize → compose cycle", () => {
    const body = "# Heading\n\nSome **markdown** with a literal --- inside.\n";
    const original = `---\ntitle: Post\n---\n${body}`;
    const parsed = parseFrontmatter(original);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rebuilt = compose(parsed.data, original.slice(parsed.bodyStart));
    expect(rebuilt.slice(rebuilt.indexOf("\n---\n") + 5)).toBe(body);
  });

  it("preserves an MDX body with imports and JSX untouched", () => {
    const body = `import Hero from '../components/Hero.astro';\n\n<Hero title="Hi" />\n\n# Content\n`;
    const original = `---\ntitle: MDX Post\nlayout: ../layouts/Doc.astro\n---\n${body}`;
    const parsed = parseFrontmatter(original);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(original.slice(parsed.bodyStart)).toBe(body);
  });
});

describe("round-trip property", () => {
  // A value domain matching the codec's supported subset: scalars, nested
  // objects, and arrays — no Date/function/undefined/non-finite numbers.
  const key = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
  const leaf = fc.oneof(
    fc.string(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.boolean(),
    fc.constant(null),
  );
  const value = fc.letrec((tie) => ({
    node: fc.oneof(
      { weight: 3, arbitrary: leaf },
      { weight: 1, arbitrary: fc.array(tie("node"), { maxLength: 4 }) },
      { weight: 1, arbitrary: fc.dictionary(key, tie("node"), { maxKeys: 4 }) },
    ),
  })).node;
  const record = fc.dictionary(key, value, { minKeys: 1, maxKeys: 6 });

  it("parse(serialize(data)) deep-equals data for all supported values", () => {
    fc.assert(
      fc.property(record, (data) => {
        const ser = serializeFrontmatter(data);
        expect(ser.ok).toBe(true);
        if (!ser.ok) return;
        const parsed = parseFrontmatter(`---\n${ser.content}---\nBODY`);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.data).toEqual(data);
      }),
      { numRuns: 500 },
    );
  });

  it("serialized frontmatter never corrupts the body", () => {
    fc.assert(
      fc.property(record, fc.string(), (data, body) => {
        const ser = serializeFrontmatter(data);
        if (!ser.ok) return;
        const file = `---\n${ser.content}---\n${body}`;
        const parsed = parseFrontmatter(file);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(file.slice(parsed.bodyStart)).toBe(body);
      }),
      { numRuns: 300 },
    );
  });
});
