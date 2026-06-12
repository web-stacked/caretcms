/**
 * Cross-package contract parity.
 *
 * caretize deliberately ships with no dependency on @caretcms/core, so the
 * contracts it must agree on — the identifier grammar, the rewrite engine's
 * tag allowlist, and the rich-text sanitizer allowlist — exist as mirror
 * copies. These tests are the lockstep mechanism: if either side changes
 * without the other, the gate fails here instead of users discovering
 * silently-inert bindings or rejected storage keys.
 *
 * The browser-sanitizer block additionally guards the editor-save sanitizer
 * (static/cms/editor/sanitize.js), which ships as raw unbundled JS and so
 * hand-mirrors the allowlist instead of importing it — a drift there is a
 * latent XSS hole (W0). This is the only automated check on that copy.
 */
import { describe, expect, it } from "vitest";

import {
  COLLECTION_NAME_RE,
  ENTRY_ID_RE,
} from "../../packages/core/src/runtime/storage/id-contracts";
import { REWRITABLE_TEXT_TAGS } from "../../packages/core/src/runtime/rewrite";
import {
  RICH_ALLOWED_ATTRS,
  RICH_ALLOWED_TAGS,
  SAFE_HREF_RE as CORE_SAFE_HREF_RE,
  classAllowed as coreClassAllowed,
} from "../../packages/core/src/runtime/rich-allowlist";

import {
  CONFIDENCE,
  RICH_INLINE_TAGS,
  RICH_SAFE_ATTRS,
  SAFE_HREF_RE as CARETIZE_SAFE_HREF_RE,
} from "../../packages/caretize/src/detect";
import { COLLECTION_RE, ID_RE } from "../../packages/caretize/src/name";

import {
  ALLOWED_TAGS as JS_ALLOWED_TAGS,
  ALLOWED_ATTRS as JS_ALLOWED_ATTRS,
  SAFE_HREF_RE as JS_SAFE_HREF_RE,
  classAllowed as jsClassAllowed,
} from "../../packages/core/static/cms/editor/sanitize.js";

describe("contracts parity (core ↔ caretize)", () => {
  it("identifier grammar: caretize mirrors core's id-contracts byte-for-byte", () => {
    expect(COLLECTION_RE.source).toBe(COLLECTION_NAME_RE.source);
    expect(COLLECTION_RE.flags).toBe(COLLECTION_NAME_RE.flags);
    expect(ID_RE.source).toBe(ENTRY_ID_RE.source);
    expect(ID_RE.flags).toBe(ENTRY_ID_RE.flags);
  });

  it("candidate tags: caretize tags exactly what the rewrite engine can render", () => {
    expect(new Set(Object.keys(CONFIDENCE))).toEqual(
      new Set(REWRITABLE_TEXT_TAGS),
    );
  });

  it("rich allowlist: caretize promotes exactly what the sanitizer keeps", () => {
    expect(RICH_INLINE_TAGS).toEqual(RICH_ALLOWED_TAGS);
    expect(Object.keys(RICH_SAFE_ATTRS).sort()).toEqual(
      Object.keys(RICH_ALLOWED_ATTRS).sort(),
    );
    for (const tag of Object.keys(RICH_ALLOWED_ATTRS)) {
      expect(RICH_SAFE_ATTRS[tag]).toEqual(RICH_ALLOWED_ATTRS[tag]);
    }
    expect(CARETIZE_SAFE_HREF_RE.source).toBe(CORE_SAFE_HREF_RE.source);
    expect(CARETIZE_SAFE_HREF_RE.flags).toBe(CORE_SAFE_HREF_RE.flags);
  });
});

describe("browser sanitizer parity (core ↔ static editor sanitize.js)", () => {
  it("allowed tags: the editor sanitizer keeps exactly the source-of-truth set", () => {
    expect(JS_ALLOWED_TAGS).toEqual(RICH_ALLOWED_TAGS);
  });

  it("allowed attrs: same per-tag attribute allowlist", () => {
    expect(Object.keys(JS_ALLOWED_ATTRS).sort()).toEqual(
      Object.keys(RICH_ALLOWED_ATTRS).sort(),
    );
    for (const tag of Object.keys(RICH_ALLOWED_ATTRS)) {
      expect(JS_ALLOWED_ATTRS[tag]).toEqual(RICH_ALLOWED_ATTRS[tag]);
    }
  });

  it("safe-href regex: byte-identical source + flags", () => {
    expect(JS_SAFE_HREF_RE.source).toBe(CORE_SAFE_HREF_RE.source);
    expect(JS_SAFE_HREF_RE.flags).toBe(CORE_SAFE_HREF_RE.flags);
  });

  it("classAllowed: identical verdicts across a behavioural battery", () => {
    // Exercise exact, prefix-`*`, lone-`*`, and reject paths — the divergence
    // a hand copy is most likely to introduce.
    const cases: Array<[string, readonly string[]]> = [
      ["gold", ["gold"]],
      ["gold", ["silver"]],
      ["text-primary", ["text-*"]],
      ["text", ["text-*"]],
      ["anything", ["*"]],
      ["x", []],
      ["accent", ["accent", "text-*"]],
      ["text-", ["text-*"]],
      ["", ["*"]],
    ];
    for (const [cls, patterns] of cases) {
      expect(jsClassAllowed(cls, patterns)).toBe(coreClassAllowed(cls, patterns));
    }
  });
});
