import { describe, expect, it } from "vitest";

/**
 * Mirror of `sanitizePath` from editor-assets.ts. The route bundles assets via
 * Vite glob, which makes the route module hard to import directly in tests
 * (the glob expression resolves to {} outside Vite). Replicating the regex
 * here both covers the path-traversal regression we care about and documents
 * the contract for future changes.
 *
 * If editor-assets.ts changes its sanitizePath, mirror it here too — and add
 * the new rejection cases to the table below.
 */
function sanitizePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.includes("\0")) return null;
  if (/[^a-zA-Z0-9_./-]/.test(normalized)) return null;
  return normalized;
}

describe("editor-assets path sanitization", () => {
  it.each([
    ["editor.js"],
    ["editor.css"],
    ["editor/toolbar.js"],
    ["studio.css"],
    ["nested/deep/path/file.svg"],
  ])("accepts legitimate asset path %s", (input) => {
    expect(sanitizePath(input)).toBe(input);
  });

  it.each([
    ["../etc/passwd"],
    ["editor/../../secret"],
    [".."],
    ["foo/..bar"],
    ["editor.js\0.png"],
    ["editor.js;rm -rf /"],
    ["editor.js?x=1"],
    ["editor.js#frag"],
    ["editor.js%2e%2e"],
    ["editor.js$INJECT"],
    ["editor.js`backtick`"],
    ["foo bar.js"],
  ])("rejects malicious or malformed path %s", (input) => {
    expect(sanitizePath(input)).toBeNull();
  });

  it("normalizes Windows backslashes before checking", () => {
    expect(sanitizePath("editor\\toolbar.js")).toBe("editor/toolbar.js");
    expect(sanitizePath("..\\etc\\passwd")).toBeNull();
  });
});
