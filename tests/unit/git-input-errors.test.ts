import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const injection = vi.hoisted(() => ({ command: "" }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped = (...args: Parameters<typeof actual.execFile>) => {
    const child = actual.execFile(...args);
    if (args[0] === "git" && Array.isArray(args[1]) && args[1][0] === injection.command &&
        (injection.command !== "hash-object" || args[1].includes("-w"))) {
      injection.command = "";
      // Reproduce a pipe closing before execFile delivers the process status.
      // The real Git subprocess still runs and produces its actual exit code.
      queueMicrotask(() => child.stdin?.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    }
    return child;
  };
  const custom = Symbol.for("nodejs.util.promisify.custom");
  Object.defineProperty(wrapped, custom, { value: Reflect.get(actual.execFile, custom) });
  return { ...actual, execFile: wrapped };
});
import { commitSnapshots } from "../../packages/core/src/runtime/git-journal";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const commit = (path: string) => commitSnapshots({ cwd: dir, sources: [{ path, content: "Approved\n" }],
  message: "approved snapshot", authorName: "Editor", authorEmail: "editor@example.invalid" });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-git-pipe-"));
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "tracked.md"), "Original\n"); git("add", "tracked.md"); git("commit", "-qm", "seed");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { injection.command = ""; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("accepts a successful commit when Git closes an unused empty stdin pipe early", async () => {
  injection.command = "commit-tree";
  expect(await commit("tracked.md")).toMatch(/^[a-f0-9]{40}$/);
  expect(git("show", "HEAD:tracked.md")).toBe("Approved");
  expect(readFileSync(join(dir, "tracked.md"), "utf8")).toBe("Original\n");
});

it("uses check-ignore's real negative result even when its input pipe reports EPIPE first", async () => {
  injection.command = "check-ignore";
  expect(await commit("new.md")).toMatch(/^[a-f0-9]{40}$/);
  expect(git("show", "HEAD:new.md")).toBe("Approved");
});

it("still rejects ignored content when check-ignore closes its input pipe", async () => {
  writeFileSync(join(dir, ".gitignore"), "ignored.md\n");
  const head = git("rev-parse", "HEAD"), index = readFileSync(join(dir, ".git/index"));
  injection.command = "check-ignore";
  expect(await commit("ignored.md")).toBeNull();
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
});

it("fails closed on an input error for a nonempty source blob despite a successful Git exit", async () => {
  const head = git("rev-parse", "HEAD"), index = readFileSync(join(dir, ".git/index"));
  // The initial empty hash is used to determine Git's object ID length.
  // The wrapper injects at the nonempty -w blob, not that initial empty hash.
  injection.command = "hash-object";
  expect(await commit("tracked.md")).toBeNull();
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
});
