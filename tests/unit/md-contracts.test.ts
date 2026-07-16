import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  formatBlockPath,
  parseBlockPath,
  formatMdBinding,
  parseMdBinding,
  formatMdSrc,
  parseMdSrc,
  fnv1a32,
} from "../../packages/core/src/markdown/contracts";
import { canonicalBody } from "../../packages/core/src/markdown/canonical-body";

describe("block path grammar", () => {
  it("round-trips index arrays", () => {
    expect(formatBlockPath([4])).toBe("4");
    expect(formatBlockPath([6, 2])).toBe("6.2");
    expect(parseBlockPath("4")).toEqual([4]);
    expect(parseBlockPath("6.2.0")).toEqual([6, 2, 0]);
  });

  it("rejects malformed paths", () => {
    for (const bad of ["", ".", "1.", ".1", "1..2", "a", "-1", "1.2.", " 1"]) {
      expect(parseBlockPath(bad)).toBeNull();
    }
  });

  it("format∘parse is identity on any index array", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(9999), { minLength: 1, maxLength: 6 }), (idx) => {
        expect(parseBlockPath(formatBlockPath(idx))).toEqual(idx);
      }),
    );
  });
});

describe("md binding grammar", () => {
  it("round-trips a valid binding", () => {
    const b = { collection: "blog", id: "hello-world", blockPath: "6.2" };
    expect(parseMdBinding(formatMdBinding(b))).toEqual(b);
  });

  it("requires the literal body field segment", () => {
    expect(parseMdBinding("blog::hello::title::4")).toBeNull();
    expect(parseMdBinding("blog::hello::body::4")).toEqual({
      collection: "blog",
      id: "hello",
      blockPath: "4",
    });
  });

  it("rejects wrong arity and bad identifiers", () => {
    for (const bad of [
      "blog::hello::body",
      "blog::hello::body::4::x",
      "Blog::hello::body::4", // uppercase collection
      "blog::Hello::body::4", // uppercase id
      "blog::hello::body::x", // non-numeric path
      "::hello::body::4",
      "blog::hello::body::",
    ]) {
      expect(parseMdBinding(bad)).toBeNull();
    }
  });
});

describe("md src hint grammar", () => {
  it("round-trips a valid hint", () => {
    const s = { start: 15, end: 79, hash: "deadbeef" };
    expect(parseMdSrc(formatMdSrc(s))).toEqual(s);
  });

  it("rejects bad bounds and malformed hashes", () => {
    for (const bad of [
      "79:15:deadbeef", // start >= end
      "15:15:deadbeef", // empty range
      "15:79:DEADBEEF", // uppercase hex
      "15:79:dead", // short hash
      "15:79:deadbeef0", // long hash
      "15:79:deadbeeg", // non-hex
      "-1:79:deadbeef",
      "15:79", // missing hash
      "a:b:deadbeef",
    ]) {
      expect(parseMdSrc(bad)).toBeNull();
    }
  });
});

describe("fnv1a32", () => {
  it("matches known FNV-1a 32-bit vectors", () => {
    // Reference values from the FNV specification.
    expect(fnv1a32("")).toBe("811c9dc5");
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(fnv1a32("foobar")).toBe("bf9cf968");
  });

  it("is 8 lowercase hex chars for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(fnv1a32(s)).toMatch(/^[0-9a-f]{8}$/);
      }),
    );
  });

  it("is deterministic and sensitive to change", () => {
    expect(fnv1a32("hello world")).toBe(fnv1a32("hello world"));
    expect(fnv1a32("hello world")).not.toBe(fnv1a32("hello worlds"));
  });
});

describe("canonicalBody", () => {
  it("strips YAML frontmatter and trims", () => {
    const file = "---\ntitle: Hi\n---\n\n# Heading\n\nBody text.\n";
    const cb = canonicalBody(file);
    expect(cb.body).toBe("# Heading\n\nBody text.");
  });

  it("strips TOML frontmatter", () => {
    const file = "+++\ntitle = 'Hi'\n+++\n\nBody.\n";
    const cb = canonicalBody(file);
    expect(cb.body).toBe("Body.");
  });

  it("handles a file with no frontmatter", () => {
    const file = "  \n\nJust body.\n\n";
    const cb = canonicalBody(file);
    expect(cb.body).toBe("Just body.");
  });

  it("mirrors Astro's fence semantics: BOM, leading blank lines, ---- close", () => {
    // These three shapes are stripped by Astro's frontmatter regex; the
    // canonical base must agree or every body save on such files 409s.
    const bom = "\uFEFF---\ntitle: x\n---\n\nBody here.";
    expect(canonicalBody(bom).body).toBe("Body here.");

    const blank = "\n\n---\ntitle: x\n---\n\nBody here.";
    expect(canonicalBody(blank).body).toBe("Body here.");

    // Astro's close matches the first three dashes of `----`; the residual
    // dash stays in the body. Odd, but agreement with Astro is the contract.
    const overlong = "---\ntitle: x\n----\nBody here.";
    expect(canonicalBody(overlong).body).toBe("-\nBody here.");

    // Offset mapping still lands on exact file bytes for the BOM shape.
    const cb = canonicalBody(bom);
    const idx = cb.body.indexOf("Body");
    expect(bom.slice(cb.fileOffsetOf(idx), cb.fileOffsetOf(idx) + 4)).toBe("Body");
  });

  it("maps canonical offsets back to the exact file bytes", () => {
    const file = "---\ntitle: Hi\n---\n\n# Heading\n\nParagraph here.\n";
    const cb = canonicalBody(file);
    const idx = cb.body.indexOf("Paragraph");
    const fileIdx = cb.fileOffsetOf(idx);
    expect(file.slice(fileIdx, fileIdx + "Paragraph".length)).toBe("Paragraph");
    // offset 0 maps to the first body byte
    expect(file.slice(cb.fileOffsetOf(0), cb.fileOffsetOf(0) + 1)).toBe("#");
  });

  it("slice-then-map is byte-exact for every substring (property)", () => {
    const bodies = ["# H\n\ntext", "- a\n- b", "> quote\n\npara", "plain paragraph"];
    fc.assert(
      fc.property(
        fc.constantFrom(...bodies),
        fc.constantFrom("---\ntitle: X\n---\n", "+++\nt = 1\n+++\n", ""),
        fc.constantFrom("", "\n", "\n\n", "  \n"),
        fc.constantFrom("", "\n", "\n\n  "),
        (body, fm, lead, trail) => {
          const file = fm + lead + body + trail;
          const cb = canonicalBody(file);
          expect(cb.body).toBe(body.trim() === body ? body : body.trim());
          // Every canonical index maps to the same character in the file.
          for (let i = 0; i < cb.body.length; i++) {
            expect(file[cb.fileOffsetOf(i)]).toBe(cb.body[i]);
          }
        },
      ),
    );
  });
});
