import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../packages/core/src/runtime/sanitize-html";

describe("sanitizeHtml — baseline allowlist", () => {
  it("keeps inline formatting tags", () => {
    expect(sanitizeHtml("<strong>Hi</strong> <em>there</em>")).toBe(
      "<strong>Hi</strong> <em>there</em>",
    );
  });

  it("drops disallowed tags but keeps their text", () => {
    expect(sanitizeHtml("<div>keep <strong>me</strong></div>")).toBe(
      "keep <strong>me</strong>",
    );
  });

  it("strips all attributes by default — including class", () => {
    expect(sanitizeHtml('<strong class="text-primary">x</strong>')).toBe(
      "<strong>x</strong>",
    );
  });

  it("keeps safe href and forces rel/target on external links", () => {
    expect(sanitizeHtml('<a href="https://x.com">l</a>')).toBe(
      '<a href="https://x.com" target="_blank" rel="noopener noreferrer">l</a>',
    );
  });
});

describe("sanitizeHtml — allowedClasses (per-tag class allowlist)", () => {
  it("preserves an allow-listed class on the matching tag", () => {
    const out = sanitizeHtml('<strong class="text-theme-text-primary">x</strong>', {
      allowedClasses: { strong: ["text-theme-text-primary"] },
    });
    expect(out).toBe('<strong class="text-theme-text-primary">x</strong>');
  });

  it("drops a class that is not allow-listed, dropping the empty attr", () => {
    const out = sanitizeHtml('<strong class="sneaky">x</strong>', {
      allowedClasses: { strong: ["text-theme-text-primary"] },
    });
    expect(out).toBe("<strong>x</strong>");
  });

  it("keeps only the matching classes from a multi-class value", () => {
    const out = sanitizeHtml('<strong class="lead sneaky highlight">x</strong>', {
      allowedClasses: { strong: ["lead", "highlight"] },
    });
    expect(out).toBe('<strong class="lead highlight">x</strong>');
  });

  it("supports prefix wildcards (text-*)", () => {
    const out = sanitizeHtml('<em class="text-accent other">x</em>', {
      allowedClasses: { em: ["text-*"] },
    });
    expect(out).toBe('<em class="text-accent">x</em>');
  });

  it("supports a lone * wildcard (any class on that tag)", () => {
    const out = sanitizeHtml('<strong class="a b c">x</strong>', {
      allowedClasses: { strong: ["*"] },
    });
    expect(out).toBe('<strong class="a b c">x</strong>');
  });

  it("scopes the allowlist per tag — class on a non-listed tag is dropped", () => {
    const out = sanitizeHtml(
      '<strong class="lead">a</strong><em class="lead">b</em>',
      { allowedClasses: { strong: ["lead"] } },
    );
    expect(out).toBe('<strong class="lead">a</strong><em>b</em>');
  });

  it("keeps class alongside href on <a>", () => {
    const out = sanitizeHtml('<a href="/x" class="cta">l</a>', {
      allowedClasses: { a: ["cta"] },
    });
    expect(out).toBe('<a href="/x" class="cta">l</a>');
  });
});
