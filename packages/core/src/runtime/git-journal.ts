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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
    // Stage adds/edits/deletes for exactly these paths.
    await exec("git", ["add", "--", ...opts.paths], { cwd: opts.cwd });

    // Nothing actually changed for these paths → skip an empty commit.
    const { stdout: staged } = await exec(
      "git",
      ["diff", "--cached", "--name-only", "--", ...opts.paths],
      { cwd: opts.cwd },
    );
    if (!staged.trim()) return null;

    const env = { ...process.env };
    if (opts.authorName) {
      env.GIT_AUTHOR_NAME = opts.authorName;
      env.GIT_COMMITTER_NAME = opts.authorName;
    }
    if (opts.authorEmail) {
      env.GIT_AUTHOR_EMAIL = opts.authorEmail;
      env.GIT_COMMITTER_EMAIL = opts.authorEmail;
    }

    // Pathspec limits the commit to these files even if other things are staged.
    await exec("git", ["commit", "-m", opts.message, "--", ...opts.paths], {
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
