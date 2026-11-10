import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSnapshots } from "../../packages/core/src/runtime/git-journal";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const commit = (sources: Array<{ path: string; content: string | null; mode?: "100644" | "100755" }>) => commitSnapshots({ cwd: dir, sources, message: "publish approved content", authorName: "Editor", authorEmail: "editor@example.invalid" });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-snapshot-git-"));
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "approved.md"), "Original\n");
  git("add", "approved.md"); git("commit", "-qm", "seed");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("immutable publication journal", () => {
  it("commits approved bytes while leaving a later working-file edit and unrelated staging intact", async () => {
    writeFileSync(join(dir, "approved.md"), "Later external edit\n");
    writeFileSync(join(dir, "other.md"), "Unrelated staged data\n"); git("add", "other.md");
    expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toMatch(/^[a-f0-9]{40}$/);
    expect(git("show", "HEAD:approved.md")).toBe("Approved");
    expect(readFileSync(join(dir, "approved.md"), "utf8")).toBe("Later external edit\n");
    expect(git("diff", "--cached", "--name-only")).toBe("other.md");
    expect(git("diff", "--name-only")).toBe("approved.md");
    expect(git("log", "-1", "--pretty=%an <%ae>")).toBe("Editor <editor@example.invalid>");
  });

  it("preserves a separately staged newer edit to the approved file", async () => {
    writeFileSync(join(dir, "approved.md"), "Separately staged\n"); git("add", "approved.md");
    const indexBlob = git("rev-parse", ":approved.md");
    expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeTruthy();
    expect(git("show", "HEAD:approved.md")).toBe("Approved");
    expect(git("rev-parse", ":approved.md")).toBe(indexBlob);
    expect(git("show", ":approved.md")).toBe("Separately staged");
  });

  it("commits deletion even if the working file has been recreated", async () => {
    writeFileSync(join(dir, "approved.md"), "Recreated after deletion\n");
    expect(await commit([{ path: "approved.md", content: null }, { path: "never.md", content: null }])).toBeTruthy();
    expect(git("ls-tree", "--name-only", "HEAD")).toBe("");
    expect(git("ls-files")).toBe("");
    expect(readFileSync(join(dir, "approved.md"), "utf8")).toBe("Recreated after deletion\n");
  });

  it("records additions that no longer exist in the working tree and literal unusual names", async () => {
    const path = "folder/file[1]\tline\n.md";
    expect(await commit([{ path, content: "Approved addition\n", mode: "100755" }])).toBeTruthy();
    expect(git("show", `HEAD:${path}`)).toBe("Approved addition");
    expect(git("ls-tree", "-r", "HEAD")).toContain("100755 blob");
    expect(existsSync(join(dir, path))).toBe(false);
  });

  it("does not mutate HEAD or the index on no-op and leaves no lock/temp files", async () => {
    const head = git("rev-parse", "HEAD"); const index = readFileSync(join(dir, ".git/index"));
    expect(await commit([{ path: "approved.md", content: "Original\n" }])).toBeNull();
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
    expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
  });

  it("skips a busy index without removing the other writer's lock", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dir, ".git/index.lock"), "owned by another writer");
    const head = git("rev-parse", "HEAD");
    expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeNull();
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dir, ".git/index.lock"), "utf8")).toBe("owned by another writer");
  });

  it.each(["../outside.md", ".git/config"])("rejects unsafe source path %s before moving HEAD", async path => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const head = git("rev-parse", "HEAD"); const index = readFileSync(join(dir, ".git/index"));
    expect(await commit([{ path, content: "Unapproved\n" }])).toBeNull();
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
    expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
  });

  it("refuses untracked ignored content", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dir, ".gitignore"), ".caret/\n");
    expect(await commit([{ path: ".caret/data/pages/home.json", content: "{}\n" }])).toBeNull();
    expect(git("log", "-1", "--pretty=%s")).toBe("seed");
  });

  it("skips merge state and conflicting snapshots without altering staging", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dir, ".git/MERGE_HEAD"), git("rev-parse", "HEAD"));
    expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeNull();
    rmSync(join(dir, ".git/MERGE_HEAD"));
    expect(await commit([{ path: "approved.md", content: "A" }, { path: "approved.md", content: "B" }])).toBeNull();
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("rejects source paths through symlinks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(dir, "real")); symlinkSync("real", join(dir, "link"));
    expect(await commit([{ path: "link/page.md", content: "Approved\n" }])).toBeNull();
  });

  it("supports split-index repositories and preserves unrelated staged data", async () => {
    git("config", "core.splitIndex", "true");
    git("update-index", "--split-index");
    writeFileSync(join(dir, "other.md"), "Other\n"); git("add", "other.md");
    expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeTruthy();
    expect(git("show", "HEAD:approved.md")).toBe("Approved");
    expect(git("diff", "--cached", "--name-only")).toBe("other.md");
  });

  it("serializes concurrent snapshots as separate commits without staging unrelated content", async () => {
    writeFileSync(join(dir, "other.md"), "Other\n"); git("add", "other.md");
    const shas = await Promise.all(["a", "b"].map(name => commit([{ path: `${name}.md`, content: name }])));
    expect(shas.every(Boolean)).toBe(true); expect(new Set(shas).size).toBe(2);
    expect(git("diff", "--cached", "--name-only")).toBe("other.md");
  });
});

it("does not lose a concurrent HEAD update or alter staging on a failed compare-and-swap", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const old = git("rev-parse", "HEAD");
  const external = git("commit-tree", `${old}^{tree}`, "-p", old, "-m", "external writer");
  const index = readFileSync(join(dir, ".git/index"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const helpers = join(dir, ".git/test-bin"); mkdirSync(helpers);
  const wrapper = join(helpers, "git");
  writeFileSync(wrapper, `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
try {
  const output = execFileSync(${JSON.stringify(realGit)}, args, { env: process.env, input: args.includes('--stdin') || args.includes('--index-info') ? readFileSync(0) : undefined });
  process.stdout.write(output);
  if (args[0] === 'commit-tree') execFileSync(${JSON.stringify(realGit)}, ['update-ref', 'HEAD', ${JSON.stringify(external)}, ${JSON.stringify(old)}], { env: process.env });
} catch (error) { process.exit(typeof error.status === 'number' ? error.status : 1); }
`);
  chmodSync(wrapper, 0o755);
  vi.stubEnv("PATH", `${helpers}:${process.env.PATH}`);
  expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeNull();
  expect(git("rev-parse", "HEAD")).toBe(external);
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
  expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
}, 30_000);

it("leaves HEAD and staging intact when configured signing fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  git("config", "commit.gpgsign", "true"); git("config", "gpg.format", "openpgp"); git("config", "gpg.program", join(dir, "missing-gpg"));
  const head = git("rev-parse", "HEAD"); const index = readFileSync(join(dir, ".git/index"));
  expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeNull();
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
  expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
});

it("captures caller snapshots before awaiting Git", async () => {
  const sources = [{ path: "approved.md", content: "Approved\n" }];
  const task = commit(sources);
  sources[0].content = "Mutated later\n";
  expect(await task).toBeTruthy();
  expect(git("show", "HEAD:approved.md")).toBe("Approved");
});

it("supports a detached HEAD and preserves its detached state", async () => {
  git("checkout", "--detach", "-q");
  expect(await commit([{ path: "approved.md", content: "Approved\n" }])).toBeTruthy();
  expect(git("show", "HEAD:approved.md")).toBe("Approved");
  expect(() => git("symbolic-ref", "-q", "HEAD")).toThrow();
});

it("creates the first commit from an immutable snapshot in an unborn repository", async () => {
  const unborn = join(dir, "unborn"); mkdirSync(unborn);
  execFileSync("git", ["init", "-q"], { cwd: unborn });
  const sha = await commitSnapshots({ cwd: unborn, sources: [{ path: "first.md", content: "First approved source\n" }], message: "first", authorName: "Editor", authorEmail: "editor@example.invalid" });
  expect(sha).toMatch(/^[a-f0-9]{40}$/);
  expect(execFileSync("git", ["show", "HEAD:first.md"], { cwd: unborn, encoding: "utf8" })).toBe("First approved source\n");
});

it("does not remove a tracked ancestor or directory through implicit Git path conflicts", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const head = git("rev-parse", "HEAD");
  expect(await commit([{ path: "approved.md/child.md", content: "Approved\n" }])).toBeNull();
  mkdirSync(join(dir, "folder")); writeFileSync(join(dir, "folder/other.md"), "Unrelated\n"); git("add", "folder"); git("commit", "-qm", "tracked directory");
  const latest = git("rev-parse", "HEAD");
  expect(await commit([{ path: "folder", content: "Approved\n" }])).toBeNull();
  expect(git("rev-parse", "HEAD")).toBe(latest);
  expect(latest).not.toBe(head);
});

it("preserves a separately staged file that obstructs a new approved path", async () => {
  writeFileSync(join(dir, "future"), "User staged file\n"); git("add", "future");
  const blob = git("rev-parse", ":future");
  expect(await commit([{ path: "future/approved.md", content: "Approved\n" }])).toBeTruthy();
  expect(git("show", "HEAD:future/approved.md")).toBe("Approved");
  expect(git("rev-parse", ":future")).toBe(blob);
  expect(readFileSync(join(dir, "future"), "utf8")).toBe("User staged file\n");
});
