import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { build } from "astro";

await build({ root: process.cwd(), logLevel: "error" });
const html = await readFile("dist/index.html", "utf8");
assert.match(html, /Consumer approved title/);
assert.doesNotMatch(html, /Fallback title/);
assert.ok(!(await readdir("dist")).includes("api"), "Static distribution must not include CMS API routes");
console.log("Packed consumer production build passed: static bake and no CMS API routes");
