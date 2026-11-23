/**
 * The `prepare` hook must survive being run outside a Git clone.
 *
 * `npm install github:web-stacked/caretcms` extracts a tarball with no
 * `.git` directory, then runs `prepare`. The old hook ran
 * `git config core.hooksPath .githooks` unconditionally, which exits 128
 * without a repository and fails the whole installation. The hook now checks
 * for a repository first and skips the config outside one.
 *
 * This spec runs the hook's shell line the way npm does: through `sh -c`, in
 * a directory with no `.git` (a temp copy of the repo's `package.json`), and
 * asserts exit 0. Inside the real repo the hooks path is still set.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const prepare = manifest.scripts?.prepare;
if (typeof prepare !== "string" || prepare.trim() === "") {
  throw new Error("package.json has no prepare script to test");
}

describe("prepare hook", () => {
  it("is tolerant outside a Git repository (tarball install)", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-prepare-nogit-"));
    try {
      // No .git here — the state an extracted GitHub tarball installs from.
      writeFileSync(join(dir, "package.json"), "{}");
      execFileSync("sh", ["-c", prepare], { cwd: dir, encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still sets the hooks path inside the repo", () => {
    execFileSync("sh", ["-c", prepare], { cwd: ROOT, encoding: "utf8" });
    const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
      cwd: ROOT, encoding: "utf8",
    }).trim();
    expect(hooksPath).toBe(".githooks");
  });
});
