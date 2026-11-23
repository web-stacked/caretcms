/**
 * The `prepare` hook must survive being run outside a Git clone, work on
 * Windows as well as POSIX shells, and never climb upward into a parent Git
 * repository's config.
 *
 * `npm install github:web-stacked/caretcms` extracts a tarball with no `.git`
 * directory, then runs `prepare`. A bare `git config` exits 128 without a repo,
 * and `git rev-parse --git-dir` walks upward into parent repositories. Checking
 * local `.git` + `.githooks` via Node handles tarballs, clones, worktrees, and
 * nested directories cleanly across platforms.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const prepare = manifest.scripts?.prepare;
if (typeof prepare !== "string" || prepare.trim() === "") {
  throw new Error("package.json has no prepare script to test");
}

/** Run the configured `prepare` script in `cwd` without requiring a POSIX shell. */
function runPrepare(cwd: string): void {
  const match = /^node\s+(\S+)$/.exec(prepare.trim());
  if (!match) throw new Error(`Expected prepare to invoke a node script, got: ${prepare}`);
  const scriptPath = resolve(ROOT, match[1]);
  execFileSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

function readHooksPath(cwd: string): string | null {
  try {
    return execFileSync("git", ["config", "--local", "core.hooksPath"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

describe("prepare hook", () => {
  it("is tolerant outside a Git repository (tarball install)", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-prepare-nogit-"));
    try {
      // No .git here — the state an extracted GitHub tarball installs from.
      writeFileSync(join(dir, "package.json"), "{}");
      mkdirSync(join(dir, ".githooks"));
      expect(() => runPrepare(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not climb upward into a parent Git repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "caret-prepare-parent-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: parent });
      execFileSync("git", ["config", "--local", "core.hooksPath", ".husky"], { cwd: parent });
      const nested = join(parent, "node_modules", "caretcms");
      mkdirSync(join(nested, ".githooks"), { recursive: true });
      writeFileSync(join(nested, "package.json"), "{}");

      expect(() => runPrepare(nested)).not.toThrow();
      expect(readHooksPath(parent)).toBe(".husky");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("sets the hooks path inside a real Git clone", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-prepare-clone-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".githooks"));
      runPrepare(dir);
      expect(readHooksPath(dir)).toBe(".githooks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets the hooks path inside a Git worktree (.git file)", () => {
    const base = mkdtempSync(join(tmpdir(), "caret-prepare-wt-"));
    const mainRepo = join(base, "main");
    const wt = join(base, "worktree");
    try {
      mkdirSync(mainRepo);
      execFileSync("git", ["init", "-q"], { cwd: mainRepo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });
      writeFileSync(join(mainRepo, "README.md"), "hi\n");
      execFileSync("git", ["add", "README.md"], { cwd: mainRepo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: mainRepo });
      execFileSync("git", ["worktree", "add", "-q", "-b", "wt-branch", wt], { cwd: mainRepo });
      mkdirSync(join(wt, ".githooks"));

      runPrepare(wt);
      expect(readHooksPath(wt)).toBe(".githooks");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
