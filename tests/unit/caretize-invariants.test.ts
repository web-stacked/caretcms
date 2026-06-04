import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAstro } from "../../packages/caretize/src/parse";
import { planFile } from "../../packages/caretize/src/plan";
import { applyTags } from "../../packages/caretize/src/write";
import {
  isValidCollection,
  isValidField,
  isValidId,
} from "../../packages/caretize/src/name";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function findAstro(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".astro" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...findAstro(full));
    else if (name.endsWith(".astro")) out.push(full);
  }
  return out;
}

// The whole corpus: hand-authored examples + vendored real-world fixtures.
const corpus = [
  ...findAstro(join(ROOT, "examples")),
  ...findAstro(join(ROOT, "tests/fixtures/caretize/real")),
];

// Force a concrete scope and the lowest confidence so EVERY candidate in every
// file is exercised through the full detect → name → write pipeline, regardless
// of where the fixture physically lives.
const OPTS = { minConfidence: "low" as const, scope: { collection: "pages", id: "test" } };

/** Frontmatter body between the leading `---` fences, or null if none. */
function frontmatter(src: string): string | null {
  const m = src.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe("caretize safety invariants over the corpus", () => {
  it("found a non-trivial corpus", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of corpus) {
    const rel = file.slice(ROOT.length);

    describe(rel, () => {
      it("tags every accepted candidate (no placement failures) and emits valid, unique bindings", async () => {
        const source = readFileSync(file, "utf8");
        const plan = await planFile(source, rel, OPTS);

        // every binding component is runtime-valid
        const bindings = new Set<string>();
        for (const t of plan.tags) {
          expect(isValidCollection(t.collection)).toBe(true);
          expect(isValidId(t.id)).toBe(true);
          expect(isValidField(t.field)).toBe(true);
          expect(bindings.has(t.binding)).toBe(false); // unique within file
          bindings.add(t.binding);
        }

        const { failures } = applyTags(
          source,
          plan.tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
        );
        expect(failures).toEqual([]); // no content element splice ever fails to place
      });

      it("output re-parses as valid Astro", async () => {
        const source = readFileSync(file, "utf8");
        const plan = await planFile(source, rel, OPTS);
        const { output } = applyTags(
          source,
          plan.tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
        );
        await expect(parseAstro(output)).resolves.toBeTruthy();
      });

      it("is pure insertion — removing inserted attributes restores the file byte-for-byte", async () => {
        const source = readFileSync(file, "utf8");
        const plan = await planFile(source, rel, OPTS);
        const { output, inserted } = applyTags(
          source,
          plan.tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
        );
        let restored = output;
        for (const attr of inserted) {
          const idx = restored.indexOf(attr);
          expect(idx).toBeGreaterThanOrEqual(0);
          restored = restored.slice(0, idx) + restored.slice(idx + attr.length);
        }
        expect(restored).toBe(source);
      });

      it("never touches frontmatter", async () => {
        const source = readFileSync(file, "utf8");
        const plan = await planFile(source, rel, OPTS);
        const { output } = applyTags(
          source,
          plan.tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
        );
        expect(frontmatter(output)).toBe(frontmatter(source));
      });

      it("is idempotent — re-planning the tagged output proposes nothing", async () => {
        const source = readFileSync(file, "utf8");
        const plan = await planFile(source, rel, OPTS);
        const { output } = applyTags(
          source,
          plan.tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute })),
        );
        const second = await planFile(output, rel, OPTS);
        expect(second.tags).toHaveLength(0);
      });
    });
  }
});
