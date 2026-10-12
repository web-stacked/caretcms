import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { filesystemStorageProvider } from "@caretcms/core/providers/storage/filesystem";
import { runStorageConformance } from "@caretcms/core/testing/storage";
import { parseAstro, planFile } from "@caretcms/caretize";
import { schemaFromZod } from "@caretcms/zod";
import { z } from "zod";

let number = 0;
const results = await runStorageConformance(async () => {
  const directory = new URL(`./storage-${number++}/`, import.meta.url);
  await mkdir(directory);
  const options = { dataRoot: new URL("data/", directory).pathname, metaRoot: new URL("meta/", directory).pathname };
  return { adapter: filesystemStorageProvider(options), reopen: async () => filesystemStorageProvider(options) };
});
assert.deepEqual(results.filter(result => result.status === "failed"), [], JSON.stringify(results));
assert.ok(await parseAstro("<h1>Example</h1>"));
assert.ok((await planFile("<h1>Example</h1>", "src/pages/index.astro")).tags.length > 0);
const schema = schemaFromZod(z.object({ title: z.string().describe("Title"), date: z.date() }));
assert.equal(schema.properties.title.title, "Title");
assert.deepEqual(schema.properties.date, { type: "string", format: "date" });
console.log("Packed filesystem conformance, Astro parsing/planning, and Zod schema conversion pass.");
