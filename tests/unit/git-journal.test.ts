import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRepo, commitPaths } from "../../packages/core/src/runtime/git-journal";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-git-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-q", "-m", "root");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isGitRepo", () => {
  it("is true inside a repo and false outside one", async () => {
    expect(await isGitRepo(dir)).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), "caret-nogit-"));
    try {
      expect(await isGitRepo(plain)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("commitPaths", () => {
  it("commits a new file and returns its sha", async () => {
    mkdirSync(join(dir, "src", "content", "pages"), { recursive: true });
    writeFileSync(join(dir, "src/content/pages/home.md"), "---\ntitle: Hi\n---\n");

    const sha = await commitPaths({
      cwd: dir,
      paths: ["src/content/pages/home.md"],
      message: "publish pages/home",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "log", "-1", "--pretty=%s").trim()).toBe("publish pages/home");
    expect(git(dir, "show", "--stat", "--pretty=", "HEAD")).toContain("src/content/pages/home.md");
  });

  it("records the provided author identity", async () => {
    writeFileSync(join(dir, "a.json"), "{}\n");
    await commitPaths({
      cwd: dir,
      paths: ["a.json"],
      message: "publish a",
      authorName: "caret-editor abc123",
      authorEmail: "editor@caret.local",
    });
    expect(git(dir, "log", "-1", "--pretty=%an <%ae>").trim()).toBe(
      "caret-editor abc123 <editor@caret.local>",
    );
  });

  it("commits a deletion", async () => {
    writeFileSync(join(dir, "gone.json"), "{}\n");
    await commitPaths({ cwd: dir, paths: ["gone.json"], message: "add gone" });
    rmSync(join(dir, "gone.json"));
    const sha = await commitPaths({ cwd: dir, paths: ["gone.json"], message: "publish delete gone" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "log", "-1", "--pretty=%s").trim()).toBe("publish delete gone");
    // file no longer tracked at HEAD
    expect(git(dir, "ls-files", "gone.json").trim()).toBe("");
  });

  it("returns null when there is nothing to commit (no empty commits)", async () => {
    const head = git(dir, "rev-parse", "HEAD").trim();
    const sha = await commitPaths({ cwd: dir, paths: ["src/content/pages/home.md"], message: "noop" });
    expect(sha).toBeNull();
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head); // HEAD unmoved
  });

  it("returns null (no throw) outside a git repo — best effort", async () => {
    const plain = mkdtempSync(join(tmpdir(), "caret-nogit-"));
    try {
      writeFileSync(join(plain, "x.json"), "{}\n");
      expect(await commitPaths({ cwd: plain, paths: ["x.json"], message: "x" })).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns null for an empty path list", async () => {
    expect(await commitPaths({ cwd: dir, paths: [], message: "nothing" })).toBeNull();
  });
});
