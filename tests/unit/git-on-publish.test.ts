import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { commitPaths } from "../../packages/core/src/runtime/git-journal";

/**
 * Integration: the W3 chain the publish route runs — draft edit → publishOverlay
 * flushes to the markdown source → commit-on-publish journals it to git. Mirrors
 * routes/publish.ts without the HTTP layer, in an isolated temp repo.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let dir: string;
let contentRoot: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-gitpub-"));
  contentRoot = join(dir, "src", "content");
  mkdirSync(join(contentRoot, "blog"), { recursive: true });
  writeFileSync(join(contentRoot, "blog", "hello.md"), "---\ntitle: Published\n---\nThe body.\n");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "repo@example.com");
  git(dir, "config", "user.name", "Repo");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed content");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("publish → markdown write → git commit", () => {
  it("flushes a draft to the .md and journals exactly that file to git", async () => {
    const base = new MarkdownAdapter({
      contentRoot,
      metaRoot: join(dir, ".caretcms"),
      draftsRoot: join(dir, ".caret", "drafts"),
    });
    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);

    // edit in the draft only — source + git untouched so far
    await draft.writeEntry("blog", "hello", { title: "Edited in draft" });
    expect(readFileSync(join(contentRoot, "blog", "hello.md"), "utf8")).toContain("title: Published");

    // publish: flush overlay → markdown source
    const published = await publishOverlay(base, overlay, { collection: "blog", id: "hello" });
    expect(published).toHaveLength(1);
    const md = readFileSync(join(contentRoot, "blog", "hello.md"), "utf8");
    expect(md).toContain("title: Edited in draft");
    expect(md).toContain("The body."); // body preserved

    // journal the publish as a commit, scoped to the content root
    const sha = await commitPaths({
      cwd: dir,
      paths: [base.committablePath()],
      message: "publish blog/hello",
      authorName: "CaretCMS editor editor-1",
      authorEmail: "editor@caretcms.local",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "log", "-1", "--pretty=%s").trim()).toBe("publish blog/hello");
    expect(git(dir, "log", "-1", "--pretty=%an").trim()).toBe("CaretCMS editor editor-1");
    // the commit contains the edited markdown, and nothing from the draft/meta dirs
    const files = git(dir, "show", "--name-only", "--pretty=", "HEAD").trim().split("\n");
    expect(files).toEqual(["src/content/blog/hello.md"]);
  });
});
