import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fault = vi.hoisted(() => ({ loseRefAck: false }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped = (...args: Parameters<typeof actual.execFile>) => {
    const command = args[1];
    if (fault.loseRefAck && Array.isArray(command) && command.includes("update-ref") && command.includes("--stdin")) {
      fault.loseRefAck = false;
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      args[args.length - 1] = ((error: Error | null, stdout: string, stderr: string) =>
        callback(error ?? new Error("Lost ref transaction acknowledgement"), stdout, stderr)) as never;
    }
    return actual.execFile(...args);
  };
  Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), { value: Reflect.get(actual.execFile, Symbol.for("nodejs.util.promisify.custom")) });
  return { ...actual, execFile: wrapped };
});
import { commitSnapshots, getGitJournalTarget, readGitJournalCommit } from "../../packages/core/src/runtime/git-journal";
let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-git-marker-"));
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "content.md"), "Original\n"); git("add", "."); git("commit", "-qm", "seed");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { fault.loseRefAck = false; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("atomically records a marker and branch commit despite a lost acknowledgement, then retries without duplicating", async () => {
  const journal = { operationId: crypto.randomUUID(), target: (await getGitJournalTarget(dir))! };
  const options = { cwd: dir, journal, sources: [{ path: "content.md", content: "Approved\n" }], message: "approved", authorName: "Editor", authorEmail: "editor@example.invalid" };
  fault.loseRefAck = true;
  expect(await commitSnapshots(options)).toBeNull();
  const committed = git("rev-parse", "HEAD");
  expect(git("show", "HEAD:content.md")).toBe("Approved");
  expect(await readGitJournalCommit(dir, journal)).toBe(committed);
  expect(await commitSnapshots(options)).toBe(committed);
  expect(git("rev-list", "--count", "HEAD")).toBe("2");
});

it("does not advance the branch if marker creation conflicts", async () => {
  const journal = { operationId: crypto.randomUUID(), target: (await getGitJournalTarget(dir))! };
  const { createHash } = await import("node:crypto");
  const marker = `refs/caretcms/journal/${createHash("sha256").update(journal.operationId).digest("hex")}`;
  // A ref to a blob cannot acknowledge a content commit, but must still prevent
  // the ref transaction from publishing an unmarked branch update.
  const blob = git("rev-parse", "HEAD:content.md"), head = git("rev-parse", "HEAD");
  git("update-ref", marker, blob);
  expect(await commitSnapshots({ cwd: dir, journal, sources: [{ path: "content.md", content: "Approved" }], message: "approved" })).toBeNull();
  expect(git("rev-parse", "HEAD")).toBe(head);
});
