import assert from "node:assert/strict";
import { planFile } from "@caretcms/caretize";

assert.ok((await planFile("<h1>Standalone CLI</h1>", "src/pages/index.astro")).tags.length > 0);
console.log("Packed Caretize planning works with core unavailable.");
