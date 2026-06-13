import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitizeHtml } from "../../packages/core/src/runtime/sanitize-html";
import {
  RICH_ALLOWED_TAGS, RICH_ALLOWED_ATTRS, SAFE_HREF_RE,
} from "../../packages/core/src/runtime/rich-allowlist";

// Property-based hardening of the rich-text sanitizer — the server-side XSS
// boundary. The example specs in sanitize-html.test.ts cover the happy paths;
// this file fuzzes adversarial input and asserts the security INVARIANTS that
// must hold for EVERY output, so a future refactor can't quietly open a hole.
//
// NOTE: the sanitizer re-escapes entities (`&lt;` → `&amp;lt;` on a second
// pass), so it is intentionally NOT idempotent — we assert structural safety,
// not output stability.

// --- Output inspectors (operate on already-sanitized HTML) ------------------

/** Every tag name appearing in the output (text `<` is escaped, so a literal
 *  `<x` in the output is always a real tag). */
function tagNames(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase());
}

/** Opening tags with their raw attribute text. */
function openingTags(html: string): { name: string; rawAttrs: string }[] {
  return [...html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)\/?>/g)].map((m) => ({
    name: m[1].toLowerCase(),
    rawAttrs: m[2],
  }));
}

/** Attribute names inside a raw attribute string (output attrs always have values). */
function attrNames(rawAttrs: string): string[] {
  return [...rawAttrs.matchAll(/([a-zA-Z][\w-]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g)]
    .map((m) => m[1].toLowerCase());
}

function hrefOf(rawAttrs: string): string | null {
  return /\bhref\s*=\s*"([^"]*)"/i.exec(rawAttrs)?.[1] ?? null;
}

/** Assert every security invariant on one sanitized output. */
function assertSafe(out: string): void {
  // 1. Only allow-listed tags survive.
  for (const name of tagNames(out)) {
    expect(RICH_ALLOWED_TAGS.has(name), `tag <${name}> escaped the allowlist in: ${out}`).toBe(true);
  }

  for (const { name, rawAttrs } of openingTags(out)) {
    // 2. Every surviving attribute is permitted for its tag (class is gated by
    //    allowedClasses; nothing else outside RICH_ALLOWED_ATTRS — kills on*=, style=, src=).
    for (const attr of attrNames(rawAttrs)) {
      const permitted = attr === "class" || (RICH_ALLOWED_ATTRS[name]?.has(attr) ?? false);
      expect(permitted, `tag <${name}> kept disallowed attr "${attr}" in: ${out}`).toBe(true);
      expect(/^on/i.test(attr), `event-handler attr survived: ${out}`).toBe(false);
    }
    // 3. Anchor hrefs are always a safe scheme; external links are hardened.
    if (name === "a") {
      const href = hrefOf(rawAttrs);
      if (href !== null) {
        expect(SAFE_HREF_RE.test(href), `unsafe href "${href}" survived in: ${out}`).toBe(true);
        if (/^https?:/i.test(href)) {
          expect(rawAttrs).toContain("target=");
          expect(rawAttrs).toContain("rel=");
        }
      }
    }
  }

  // 4. No raw script/style/iframe markup anywhere.
  expect(/<\s*\/?\s*(script|style|iframe|object|embed|svg)/i.test(out), `dangerous element in: ${out}`).toBe(false);
}

// --- Explicit adversarial cases (documentation of the contract) -------------

describe("sanitizeHtml — XSS invariants (examples)", () => {
  const cases: [string, string][] = [
    ["drops <script> entirely", "<script>alert(1)</script>"],
    ["drops a broken-up script", "<scr<script>ipt>alert(1)</script>"],
    ["strips event handlers off an allowed tag", "<strong onmouseover=alert(1)>x</strong>"],
    ["drops a tag carrying only an event handler", "<div onclick=\"steal()\">x</div>"],
    ["neutralizes javascript: hrefs", '<a href="javascript:alert(1)">x</a>'],
    ["neutralizes mixed-case JaVaScRiPt: hrefs", '<a href="JaVaScRiPt:alert(1)">x</a>'],
    ["neutralizes data: hrefs", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ["drops <img onerror>", "<img src=x onerror=alert(1)>"],
    ["drops inline <style>", "<style>body{background:url(javascript:1)}</style>"],
    ["drops <svg onload>", "<svg/onload=alert(1)>"],
    ["strips style= attributes", '<strong style="position:fixed">x</strong>'],
    // span is an allowed rich tag (W4) but carries NO attrs except class-via-allowedClasses:
    ["strips event handlers off a span", "<span onclick=alert(1)>x</span>"],
    ["strips style off a span", '<span style="position:fixed">x</span>'],
    ["drops an unblessed class off a span", '<span class="evil">x</span>'],
  ];
  for (const [name, payload] of cases) {
    it(name, () => {
      const out = sanitizeHtml(payload);
      // No dangerous ELEMENT survives (these can only be tags — text `<` is
      // escaped). Dangerous-looking *text* like a stray "javascript:" inside a
      // dropped tag's content is inert and allowed; assertSafe proves the rest.
      expect(out).not.toMatch(/<\s*\/?\s*(script|style|svg|img|iframe|object|embed)/i);
      assertSafe(out);
    });
  }

  it("hardens external links and preserves safe ones", () => {
    expect(sanitizeHtml('<a href="https://x.com">l</a>')).toBe(
      '<a href="https://x.com" target="_blank" rel="noopener noreferrer">l</a>',
    );
  });
});

// --- Fuzz ------------------------------------------------------------------

const ALLOWED = [...RICH_ALLOWED_TAGS];
const word = fc.stringMatching(/^[a-z0-9 ]{0,10}$/);

const ADVERSARIAL = [
  "<script>alert(1)</script>",
  '"><script>alert(1)</script>',
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="data:text/html,<b>x</b>">y</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  "<div onclick=\"steal()\">x</div>",
  "<strong onmouseover=alert(1)>x</strong>",
  "<iframe src=//evil></iframe>",
  "<style>body{}</style>",
  "<svg/onload=alert(1)>",
  "<a href=javascript:alert(1)>x</a>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  '<STRONG STYLE="x" CLASS="lead">x</STRONG>',
  "< script >",
  "<a href='/ok' onclick='x'>l</a>",
  '<span onclick="x()" style="z" class="gold">x</span>',
  '<span class="gold">styled</span>',
  "<>", "</b>", "<a>", "<b/>", "a < b && c > d",
];

const fragment = fc.oneof(
  fc.constantFrom(...ADVERSARIAL),
  fc.record({ tag: fc.constantFrom(...ALLOWED), text: word }).map(({ tag, text }) => `<${tag}>${text}</${tag}>`),
  word,
  fc.string(),
  fc.constantFrom(
    '<a href="https://ext.com">x</a>',
    '<a href="/rel">x</a>',
    '<a href="mailto:a@b.c">x</a>',
    '<a href="tel:+1">x</a>',
  ),
);

const doc = fc.array(fragment, { maxLength: 10 }).map((a) => a.join(""));

const classesOpt = fc.option(
  fc.constantFrom(
    { strong: ["lead", "text-*"] },
    { a: ["cta"] },
    { em: ["*"] },
    { strong: ["lead"], a: ["cta"] },
    { span: ["gold", "text-*"] },
  ),
  { nil: undefined },
);

describe("sanitizeHtml — fuzzed security invariants", () => {
  it("never lets a disallowed tag, attribute, or unsafe href through", () => {
    fc.assert(
      fc.property(doc, classesOpt, (html, allowedClasses) => {
        const out = sanitizeHtml(html, allowedClasses ? { allowedClasses } : undefined);
        assertSafe(out);
      }),
      { numRuns: 2000 },
    );
  });
});
