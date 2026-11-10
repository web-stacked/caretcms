/**
 * Git journal — best-effort, opt-in commit of published content.
 *
 * When content lives as files in a git repo, a publish can become a real commit:
 * blame, revert, branch-per-draft, and PR review of content all come for free.
 * This is deliberately BEST-EFFORT — a git failure logs and returns null, never
 * throwing into the publish path or blocking the response. Guarded by
 * `isGitRepo`, so non-filesystem deployments (KV/R2) simply never call it.
 *
 * Uses the `git` CLI (already a dependency of preflight) via async execFile, so
 * it never blocks the event loop. Commits are scoped with a pathspec so only the
 * published files land in the commit, never unrelated working-tree changes.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { PublicationSourceSnapshot, GitJournalTarget } from "../types.js";
import { serializeWrite } from "./storage/atomic-write.js";

const exec = promisify(execFile);

/** True when `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export interface CommitOptions {
  /** Repo working directory (a publish runs from the project root). */
  cwd: string;
  /** Files to stage + commit (absolute or repo-relative). Adds, edits, deletes. */
  paths: string[];
  message: string;
  /** Commit author/committer identity (e.g. the editor). Falls back to git config. */
  authorName?: string;
  authorEmail?: string;
}

/**
 * Stage `paths` and commit them. Returns the new commit SHA, or null when there
 * is nothing to commit or anything goes wrong (not a repo, git missing, no diff,
 * git error). Never throws.
 */
export async function commitPaths(opts: CommitOptions): Promise<string | null> {
  if (opts.paths.length === 0) return null;
  try {
    const { stdout } = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: opts.cwd });
    return await serializeWrite(`git-journal::${stdout.trim()}`, () => commitLocked(opts));
  } catch (err) {
    console.warn(`[caretcms] git journal commit skipped: ${(err as Error).message}`);
    return null;
  }
}

async function commitLocked(opts: CommitOptions): Promise<string | null> {
  try {
    const gitOptions = { cwd: opts.cwd, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } };
    // Deletion capabilities may include alternate source extensions that were
    // never tracked. Passing such an absent path to git add aborts the batch.
    const paths: string[] = [];
    for (const path of opts.paths) {
      try {
        if (!(await stat(isAbsolute(path) ? path : resolve(opts.cwd, path))).isFile()) throw new Error("Journal requires exact file paths");
        paths.push(path);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        const { stdout } = await exec("git", ["ls-files", "--", path], gitOptions);
        if (stdout.trim()) paths.push(path);
      }
    }
    if (!paths.length) return null;
    // Stage adds/edits/deletes for exactly these paths.
    await exec("git", ["add", "--", ...paths], gitOptions);

    // Nothing actually changed for these paths → skip an empty commit.
    const { stdout: staged } = await exec(
      "git",
      ["diff", "--cached", "--name-only", "--", ...paths],
      gitOptions,
    );
    if (!staged.trim()) return null;

    const env: Record<string, string | undefined> = { ...gitOptions.env };
    if (opts.authorName) {
      env.GIT_AUTHOR_NAME = opts.authorName;
      env.GIT_COMMITTER_NAME = opts.authorName;
    }
    if (opts.authorEmail) {
      env.GIT_AUTHOR_EMAIL = opts.authorEmail;
      env.GIT_COMMITTER_EMAIL = opts.authorEmail;
    }

    // Pathspec limits the commit to these files even if other things are staged.
    await exec("git", ["commit", "-m", opts.message, "--", ...paths], {
      cwd: opts.cwd,
      env,
    });

    const { stdout: sha } = await exec("git", ["rev-parse", "HEAD"], { cwd: opts.cwd });
    return sha.trim();
  } catch (err) {
    console.warn(`[caretcms] git journal commit skipped: ${(err as Error).message}`);
    return null;
  }
}

/** Journal approved bytes, without staging or reading current working-file content. */
export interface SnapshotCommitOptions extends Omit<CommitOptions, "paths"> {
  sources: PublicationSourceSnapshot[];
  /** Durable idempotency marker, atomically advanced with the target ref. */
  journal?: { operationId: string; target: GitJournalTarget };
}

/** Capture a repository/checkout identity without serializing runtime credentials. */
export async function getGitJournalTarget(cwd: string): Promise<GitJournalTarget | null> {
  try {
    const { realpath } = await import("node:fs/promises");
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    const git = async (args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const root = await realpath(await git(["rev-parse", "--show-toplevel"]));
    const gitDir = await realpath(await git(["rev-parse", "--absolute-git-dir"]));
    let ref: string;
    try { ref = await git(["symbolic-ref", "-q", "HEAD"]); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; ref = "HEAD"; }
    let head: string | null;
    try { head = await git(["rev-parse", "--verify", "HEAD"]); }
    catch (error) { if ((error as { code?: number }).code !== 128) throw error; head = null; }
    return { root, gitDir, ref, head };
  } catch { return null; }
}

function journalRef(operationId: string): string {
  return `refs/caretcms/journal/${createHash("sha256").update(operationId).digest("hex")}`;
}

/** A marker acknowledges an earlier journal, even if base content advanced later. */
export async function readGitJournalCommit(cwd: string, journal: NonNullable<SnapshotCommitOptions["journal"]>): Promise<string | null> {
  const current = await getGitJournalTarget(cwd);
  if (!current || current.root !== journal.target.root || current.gitDir !== journal.target.gitDir ||
      current.ref !== journal.target.ref || !current.head) return null;
  try {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    const options = { cwd, env, timeout: 10_000 };
    const { stdout } = await exec("git", ["rev-parse", "--verify", `${journalRef(journal.operationId)}^{commit}`], options);
    const sha = stdout.trim();
    await exec("git", ["merge-base", "--is-ancestor", sha, current.head], options);
    return sha;
  } catch { return null; }
}

type GitEntry = { mode: string; oid: string };

function gitEntries(output: string, tree: boolean): Map<string, GitEntry> {
  const entries = new Map<string, GitEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const fields = record.slice(0, tab).split(" ");
    if (tab < 0 || (!tree && fields[2] !== "0")) throw new Error("Journal requires a resolved index");
    entries.set(record.slice(tab + 1), { mode: fields[0], oid: fields[tree ? 2 : 1] });
  }
  return entries;
}

function sameGitEntry(left: GitEntry | undefined, right: GitEntry | undefined): boolean {
  return left?.mode === right?.mode && left?.oid === right?.oid;
}

/** Async execFile does not accept stdin as an option. Never put source bytes in argv. */
function gitInput(args: string[], input: string, options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolveInput, reject) => {
    let inputError: NodeJS.ErrnoException | undefined;
    const child = execFile("git", args, { ...options, timeout: 10_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // Git's status is authoritative (e.g. check-ignore's ordinary exit 1).
      // commit-tree -m does not read stdin and can close its empty pipe before
      // Node completes end("") on Linux. No source bytes were lost in that case.
      if (error) reject(error);
      else if (inputError && !(input.length === 0 && inputError.code === "EPIPE")) reject(inputError);
      else resolveInput(stdout);
    });
    child.stdin?.on("error", error => { inputError = error; });
    child.stdin?.end(input);
  });
}

/** Best effort. A busy index or changed HEAD skips journaling without altering publication. */
export async function commitSnapshots(opts: SnapshotCommitOptions): Promise<string | null> {
  if (!opts.sources.length) return null;
  const immutable = { ...opts, sources: opts.sources.map(source => ({ ...source })) };
  try {
    const { stdout } = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: opts.cwd });
    return await serializeWrite(`git-journal::${stdout.trim()}`, async () => {
      if (immutable.journal) {
        const previous = await readGitJournalCommit(opts.cwd, immutable.journal);
        if (previous) return previous;
      }
      return commitSnapshotsLocked(immutable, stdout.trim());
    });
  } catch (error) {
    console.warn("[caretcms] Immutable Git journal skipped:", (error as Error).message);
    return null;
  }
}

async function commitSnapshotsLocked(opts: SnapshotCommitOptions, gitDir: string): Promise<string | null> {
  const { open, readFile, writeFile, copyFile, rename, unlink, mkdtemp, rm, lstat, chmod, realpath } = await import("node:fs/promises");
  const { join, relative, sep } = await import("node:path");
  let indexLock: string | undefined;
  let temporary: string | undefined;
  let committed: string | null = null;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };
    delete env.GIT_INDEX_FILE;
    const gitOptions = { cwd: opts.cwd, env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 };
    const git = async (args: string[], index?: string) => (await exec("git", ["-c", "core.splitIndex=false", ...args], {
      ...gitOptions, env: index ? { ...env, GIT_INDEX_FILE: index } : env,
    })).stdout;
    const optionalGit = async (args: string[]) => {
      try { return (await git(args)).trim(); }
      catch (error) { if ((error as { code?: number }).code === 1 || (error as { code?: number }).code === 128) return null; throw error; }
    };
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    const canonicalCwd = await realpath(opts.cwd);
    const indexPath = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    const lockPath = `${indexPath}.lock`;
    // Cooperate with Git's normal index lock. Never remove someone else's lock.
    const lock = await open(lockPath, "wx", 0o600);
    indexLock = lockPath;
    await lock.close();
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      try { await lstat(join(gitDir, marker)); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
      throw new Error("Journal skipped during an in-progress Git operation");
    }
    const head = await optionalGit(["rev-parse", "--verify", "HEAD"]);
    const branch = await optionalGit(["symbolic-ref", "-q", "HEAD"]);
    if (!head && !branch) throw new Error("Journal requires a valid HEAD");
    if (opts.journal) {
      const target = await getGitJournalTarget(opts.cwd);
      if (!target || target.root !== opts.journal.target.root || target.gitDir !== opts.journal.target.gitDir ||
          target.ref !== opts.journal.target.ref || (target.ref === "HEAD" && target.head !== opts.journal.target.head)) {
        throw new Error("Git journal checkout changed since publication");
      }
      // An existing marker outside the current ancestry means the journal was
      // rewritten/reset. Never replay it as a fresh publication.
      if (await optionalGit(["rev-parse", "--verify", journalRef(opts.journal.operationId)])) {
        throw new Error("Git journal marker is not in the current checkout history");
      }
    }
    const headTree = head ? (await git(["rev-parse", `${head}^{tree}`])).trim() : null;
    const before = head ? gitEntries(await git(["ls-tree", "-r", "-z", head]), true) : new Map<string, GitEntry>();
    const staged = gitEntries(await git(["ls-files", "--stage", "-z"]), false);
    const directories = (entries: Map<string, GitEntry>) => {
      const result = new Set<string>();
      for (const path of entries.keys()) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) result.add(parts.slice(0, i).join("/"));
      }
      return result;
    };
    const trackedDirectories = directories(before);
    const stagedDirectories = directories(staged);
    const snapshots = new Map<string, PublicationSourceSnapshot>();
    for (const source of opts.sources) {
      if (!source.path || source.path.includes("\0") || (source.content !== null && typeof source.content !== "string") ||
          (source.mode !== undefined && source.mode !== "100644" && source.mode !== "100755")) throw new Error("Invalid source snapshot");
      const absolute = isAbsolute(source.path) ? resolve(source.path) : resolve(opts.cwd, source.path);
      const outside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
      let local = relative(root, absolute);
      // Git canonicalizes system aliases such as macOS /tmp → /private/tmp.
      // Rebase from the canonical cwd, without following source symlinks.
      if (outside(local)) local = relative(root, resolve(canonicalCwd, relative(resolve(opts.cwd), absolute)));
      if (!local || outside(local)) throw new Error("Journal source must be inside the repository");
      const parts = local.split(sep);
      if (parts.some(part => part.toLowerCase() === ".git")) throw new Error("Git metadata is not a content source");
      for (let i = 1; i < parts.length; i++) {
        const parent = join(root, ...parts.slice(0, i));
        try { if ((await lstat(parent)).isSymbolicLink()) throw new Error("Journal source crosses a symlink"); }
        catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
        if (before.has(parts.slice(0, i).join("/"))) throw new Error("Journal source has a tracked file or submodule ancestor");
      }
      const path = parts.join("/");
      if (trackedDirectories.has(path)) throw new Error("Journal cannot replace a tracked directory");
      const prior = snapshots.get(path);
      if (prior && (prior.content !== source.content || prior.mode !== source.mode)) throw new Error("Conflicting source snapshots");
      snapshots.set(path, source);
      if (source.content !== null && !before.has(path) && !staged.has(path)) {
        const ignoreEnv = { ...env };
        delete ignoreEnv.GIT_LITERAL_PATHSPECS;
        try { await gitInput(["check-ignore", "--quiet", "--no-index", "-z", "--stdin"], `${path}\0`, { cwd: root, env: ignoreEnv }); }
        catch (error) { if ((error as { code?: number }).code === 1) continue; throw error; }
        throw new Error("Journal does not force-add ignored source files");
      }
    }
    const paths = [...snapshots.keys()].sort();
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (snapshots.has(parts.slice(0, i).join("/"))) throw new Error("Overlapping source paths");
      }
    }
    temporary = await mkdtemp(join(gitDir, "caret-journal-"));
    const commitIndex = join(temporary, "commit-index");
    const nextIndex = join(temporary, "next-index");
    await git(head ? ["read-tree", head] : ["read-tree", "--empty"], commitIndex);
    let indexMode = 0o600;
    try {
      indexMode = (await stat(indexPath)).mode & 0o777;
      await copyFile(indexPath, nextIndex);
      await git(["update-index", "--no-split-index"], nextIndex);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      await git(["read-tree", "--empty"], nextIndex);
    }
    const zero = "0".repeat((await gitInput(["hash-object", "--stdin"], "", { cwd: opts.cwd, env })).trim().length);
    let commitUpdates = "";
    let indexUpdates = "";
    for (const path of paths) {
      const source = snapshots.get(path)!;
      const previous = before.get(path);
      const mode = source.mode ?? (previous?.mode === "100755" ? "100755" : "100644");
      const oid = source.content === null ? zero : (await gitInput(["hash-object", "-w", "--stdin"], source.content, { cwd: opts.cwd, env })).trim();
      const approved: GitEntry | undefined = source.content === null ? undefined : { mode, oid };
      const update = `${approved ? `${mode} ${oid}` : `0 ${zero}`}\t${path}\0`;
      commitUpdates += update;
      // Refresh an unchanged old-HEAD index entry. Preserve any separately
      // staged edit/deletion, including one to the approved file itself.
      const parts = path.split("/");
      const obstruction = stagedDirectories.has(path) || parts.some((_, i) => i > 0 && staged.has(parts.slice(0, i).join("/")));
      if (!obstruction && (sameGitEntry(staged.get(path), previous) || sameGitEntry(staged.get(path), approved))) indexUpdates += update;
    }
    await gitInput(["-c", "core.splitIndex=false", "update-index", "-z", "--index-info"], commitUpdates, { cwd: opts.cwd, env: { ...env, GIT_INDEX_FILE: commitIndex } });
    const tree = (await git(["write-tree"], commitIndex)).trim();
    if (tree === headTree || (!head && !(await git(["ls-files", "-z"], commitIndex)))) {
      if (!opts.journal) return null;
      if (head) {
        // The approved tree is already current. Record a durable acknowledgement
        // without creating an empty commit or changing the user's index.
        await gitInput(["update-ref", "--stdin"], `start\nverify ${branch ?? "HEAD"} ${head}\ncreate ${journalRef(opts.journal.operationId)} ${head}\nprepare\ncommit\n`, { cwd: opts.cwd, env });
        return head;
      }
    }
    if (indexUpdates) await gitInput(["-c", "core.splitIndex=false", "update-index", "-z", "--index-info"], indexUpdates, { cwd: opts.cwd, env: { ...env, GIT_INDEX_FILE: nextIndex } });
    // Prepare the complete next real index before moving HEAD. The lock keeps
    // normal concurrent Git writers from changing the user's staging state.
    await writeFile(lockPath, await readFile(nextIndex));
    await chmod(lockPath, indexMode);
    const commitEnv = { ...env };
    if (opts.authorName) commitEnv.GIT_AUTHOR_NAME = commitEnv.GIT_COMMITTER_NAME = opts.authorName;
    if (opts.authorEmail) commitEnv.GIT_AUTHOR_EMAIL = commitEnv.GIT_COMMITTER_EMAIL = opts.authorEmail;
    const sign = (await optionalGit(["config", "--bool", "--get", "commit.gpgsign"])) === "true";
    const sha = (await gitInput(["commit-tree", ...(sign ? ["-S"] : []), tree, ...(head ? ["-p", head] : []), "-m", opts.message], "", { cwd: opts.cwd, env: commitEnv })).trim();
    if ((await optionalGit(["symbolic-ref", "-q", "HEAD"])) !== branch) throw new Error("HEAD changed while journaling");
    if (opts.journal) {
      const old = head ?? zero;
      await gitInput(["update-ref", "-m", `commit: ${opts.message}`, "--stdin"],
        `start\nupdate ${branch ?? "HEAD"} ${sha} ${old}\ncreate ${journalRef(opts.journal.operationId)} ${sha}\nprepare\ncommit\n`, { cwd: opts.cwd, env });
    } else {
      await git(["update-ref", "-m", `commit: ${opts.message}`, branch ?? "HEAD", sha, head ?? ""]);
    }
    committed = sha;
    await rename(lockPath, indexPath);
    indexLock = undefined;
    return committed;
  } catch (error) {
    console.warn(`[caretcms] Immutable Git journal ${committed ? "committed; index refresh failed" : "skipped"}:`, (error as Error).message);
    return committed;
  } finally {
    if (indexLock) await unlink(indexLock).catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
