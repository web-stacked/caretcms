import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { hasUncommittedChanges } from "../../packages/core/src/runtime/git-journal";

/**
 * With git-on-publish, a publish commits each entry's source file. A file a
 * developer changed and hasn't committed would be committed with it, under
 * the editor's name, so that entry is held back until the editor agrees.
 */

describe("hasUncommittedChanges", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-uncommitted-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, "a.md"), "one\n");
    writeFileSync(join(dir, "b.md"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is false for committed files", async () => {
    expect(await hasUncommittedChanges(dir, ["a.md", "b.md"])).toBe(false);
  });

  it("is true for a modified file, staged or not, and only for the paths asked about", async () => {
    writeFileSync(join(dir, "a.md"), "two\n");
    expect(await hasUncommittedChanges(dir, ["a.md"])).toBe(true);
    expect(await hasUncommittedChanges(dir, ["b.md"])).toBe(false);
    git("add", "a.md");
    expect(await hasUncommittedChanges(dir, ["a.md"])).toBe(true);
  });

  it("is false for a file Git doesn't track yet, and outside a repository", async () => {
    writeFileSync(join(dir, "new.md"), "new\n");
    expect(await hasUncommittedChanges(dir, ["new.md"])).toBe(false);
    expect(await hasUncommittedChanges(tmpdir(), ["nothing.md"])).toBe(false);
    expect(await hasUncommittedChanges(dir, [])).toBe(false);
  });
});

describe("publishing an entry whose file has uncommitted changes", () => {
  async function setup() {
    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Old" });
    await base.writeEntry("pages", "about", { title: "Old" });
    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);
    await draft.writeEntry("pages", "home", { title: "New home" });
    await draft.writeEntry("pages", "about", { title: "New about" });
    return { base, overlay };
  }

  it("holds that entry back and publishes the others", async () => {
    const { base, overlay } = await setup();
    const outcome = await publishOverlay(base, overlay, {}, { holdUncommitted: async (_collection, id) => id === "home" });
    expect(outcome.conflicts).toEqual([{ collection: "pages", id: "home", reason: "uncommitted_source" }]);
    expect(outcome.published.map((entry) => entry.id)).toEqual(["about"]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Old" });
    expect(await overlay.getEntry("pages", "home")).not.toBeNull();
  });

  it("publishes it once the editor agrees", async () => {
    const { base, overlay } = await setup();
    await publishOverlay(base, overlay, {}, { holdUncommitted: async () => true });
    const outcome = await publishOverlay(base, overlay);
    expect(outcome.conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "New home" });
  });

  it("doesn't ask about a draft that changes nothing", async () => {
    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Old" });
    const overlay = await base.makeEditorOverlay("editor-1");
    await new SessionOverlayAdapter(base, overlay).writeEntry("pages", "home", { title: "Old" });
    let asked = 0;
    const outcome = await publishOverlay(base, overlay, {}, { holdUncommitted: async () => { asked += 1; return true; } });
    expect(outcome.conflicts).toEqual([]);
    expect(asked).toBe(0);
  });
});
