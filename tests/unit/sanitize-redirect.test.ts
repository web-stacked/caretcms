import { describe, expect, it } from "vitest";
import { sanitizeRedirect } from "../../packages/core/src/runtime/auth/cookie-utils";

// `sanitizeRedirect(value, fallback)` is what makes `editorHome` the post-login
// landing: the login routes pass the resolved `editorHome` as the fallback, so
// an explicit same-origin `?redirect=` wins and anything else degrades to home.
describe("sanitizeRedirect", () => {
  const HOME = "/";

  it("keeps a same-origin absolute path", () => {
    expect(sanitizeRedirect("/blog", HOME)).toBe("/blog");
  });

  it("preserves the query string on a same-origin path", () => {
    expect(sanitizeRedirect("/blog?ref=nav", HOME)).toBe("/blog?ref=nav");
  });

  it("falls back to editorHome when no redirect is provided", () => {
    expect(sanitizeRedirect(null, HOME)).toBe(HOME);
    expect(sanitizeRedirect(undefined, HOME)).toBe(HOME);
    expect(sanitizeRedirect("", HOME)).toBe(HOME);
  });

  it("rejects protocol-relative URLs (open-redirect guard)", () => {
    expect(sanitizeRedirect("//evil.com", HOME)).toBe(HOME);
  });

  it("rejects absolute and scheme-relative off-origin targets", () => {
    expect(sanitizeRedirect("https://evil.com", HOME)).toBe(HOME);
    expect(sanitizeRedirect("javascript:alert(1)", HOME)).toBe(HOME);
    expect(sanitizeRedirect("../escape", HOME)).toBe(HOME);
  });

  it("honors a non-root editorHome fallback", () => {
    expect(sanitizeRedirect(null, "/dashboard")).toBe("/dashboard");
  });
});
