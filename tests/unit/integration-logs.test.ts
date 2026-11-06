import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("integration log messages", () => {
  it("leave the [caretcms] label to Astro's integration logger", () => {
    const source = readFileSync(new URL("../../packages/core/src/index.ts", import.meta.url), "utf8");
    const prefixed = [...source.matchAll(/logger\??\.(?:info|warn|error|debug)\(\s*[`"']\[caretcms\]/g)].map((match) => match[0]);
    expect(prefixed).toEqual([]);
  });
});
