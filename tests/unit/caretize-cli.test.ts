import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAstroFiles } from "../../packages/caretize/src/discover";
import { prepareFile, commitRun, type PreparedFile } from "../../packages/caretize/src/run";
import { listBackups, restoreLatest } from "../../packages/caretize/src/backup";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caretize-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("discoverAstroFiles", () => {
  it("finds .astro under src, skipping vendor dirs, dynamic ignores, and test files", () => {
    write("src/pages/index.astro", "<h1>x</h1>");
    write("src/pages/about.astro", "<h1>y</h1>");
    write("src/components/Card.test.astro", "<h1>t</h1>");
    write("node_modules/pkg/x.astro", "<h1>no</h1>");
    write(".astro/types.astro", "<h1>no</h1>");
    write("dist/out.astro", "<h1>no</h1>");

    const found = discoverAstroFiles(dir);
    expect(found).toEqual(["src/pages/about.astro", "src/pages/index.astro"]);
  });

  it("can target a single file", () => {
    write("src/pages/index.astro", "<h1>x</h1>");
    write("src/pages/about.astro", "<h1>y</h1>");
    expect(discoverAstroFiles(dir, "src/pages/about.astro")).toEqual(["src/pages/about.astro"]);
  });
});

describe("prepareFile verification gate", () => {
  it("accepts a valid splice", async () => {
    const src = "<main>\n  <h1>Hello</h1>\n</main>\n";
    const start = src.indexOf("<h1>");
    const p = await prepareFile("p.astro", src, [
      { startOffset: start, attribute: 'data-caret="pages::home::headline"' },
    ]);
    expect(p.ok).toBe(true);
    expect(p.output).toContain('<h1 data-caret="pages::home::headline">Hello</h1>');
  });

  it("rejects a bad offset without corrupting", async () => {
    const src = "<main>\n  <h1>Hello</h1>\n</main>\n";
    const p = await prepareFile("p.astro", src, [
      { startOffset: 1, attribute: 'data-caret="x::y::z"' },
    ]);
    expect(p.ok).toBe(false);
    expect(p.output).toBe(src);
  });
});

describe("commitRun + backups + restore", () => {
  it("writes the file, backs up the original, and --restore reverts it", async () => {
    const src = "<main>\n  <h1>Hello</h1>\n</main>\n";
    write("src/pages/index.astro", src);
    const start = src.indexOf("<h1>");
    const prepared = [
      await prepareFile("src/pages/index.astro", src, [
        { startOffset: start, attribute: 'data-caret="pages::home::headline"' },
      ]),
    ];

    const { written, backups } = commitRun(dir, prepared, "2026-01-01T00-00-00-000Z");
    expect(written).toEqual(["src/pages/index.astro"]);
    expect(backups).toHaveLength(1);

    // file now tagged
    const after = readFileSync(join(dir, "src/pages/index.astro"), "utf8");
    expect(after).toContain('data-caret="pages::home::headline"');
    // backup is byte-identical to the original
    expect(readFileSync(backups[0], "utf8")).toBe(src);
    expect(listBackups(dir)).toHaveLength(1);

    // restore reverts
    const restored = restoreLatest(dir);
    expect(restored).toEqual(["src/pages/index.astro"]);
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toBe(src);
  });

  it("is atomic: a failed-verification file aborts the whole run with no writes", async () => {
    const goodSrc = "<main><h1>A</h1></main>";
    write("a.astro", goodSrc);
    write("b.astro", goodSrc);

    const prepared: PreparedFile[] = [
      await prepareFile("a.astro", goodSrc, [
        { startOffset: goodSrc.indexOf("<h1>"), attribute: 'data-caret="pages::home::headline"' },
      ]),
      // a deliberately failed prepared file
      { relPath: "b.astro", source: goodSrc, output: goodSrc, inserted: [], tagCount: 1, ok: false, reason: "forced" },
    ];

    expect(() => commitRun(dir, prepared, "2026-01-01T00-00-00-000Z")).toThrow(/verification/);
    // nothing written, no backups left behind
    expect(readFileSync(join(dir, "a.astro"), "utf8")).toBe(goodSrc);
    expect(existsSync(join(dir, ".caret"))).toBe(false);
  });

  it("a failed write rolls back only this run — older backups stay untouched", async () => {
    // Run 1 tags a.astro, leaving a backup at an older stamp.
    const srcA = "<main><h1>A</h1></main>";
    write("a.astro", srcA);
    commitRun(
      dir,
      [
        await prepareFile("a.astro", srcA, [
          { startOffset: srcA.indexOf("<h1>"), attribute: 'data-caret="pages::a::headline"' },
        ]),
      ],
      "2026-01-01T00-00-00-000Z",
    );

    // The user then hand-edits a.astro.
    const handEdited = "<main><h1>USER EDIT</h1></main>";
    write("a.astro", handEdited);

    // Run 2 targets only b.astro and fails mid-write (its target dir vanished —
    // writeBackup succeeds, writeFileSync throws on the missing parent).
    const srcB = "<main><h1>B</h1></main>";
    write("deep/b.astro", srcB);
    const prepared = [
      await prepareFile("deep/b.astro", srcB, [
        { startOffset: srcB.indexOf("<h1>"), attribute: 'data-caret="pages::b::headline"' },
      ]),
    ];
    rmSync(join(dir, "deep"), { recursive: true, force: true });

    expect(() => commitRun(dir, prepared, "2026-01-02T00-00-00-000Z")).toThrow(/rolled back/);
    // The rollback must NOT have restored run 1's stamp over the user's edit.
    expect(readFileSync(join(dir, "a.astro"), "utf8")).toBe(handEdited);
  });
});
