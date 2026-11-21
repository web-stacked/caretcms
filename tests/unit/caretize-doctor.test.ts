import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect, report, type Inspection } from "../../packages/caretize/src/doctor";

const NOW = Date.UTC(2026, 10, 21, 12);
const healthy: Inspection = {
  coreVersion: "0.6.3", configName: "astro.config.mjs", configWired: true, drafts: [], git: true, uncommitted: [],
  commitsOnPublish: false, ignoredUploads: false, draftsNotIgnored: false, envNotIgnored: false, unusedUploads: [],
  missingSecret: false, placeholderPassword: false,
};

describe("caretize doctor report", () => {
  it("says so when everything is right", () => {
    const result = report(healthy, NOW);
    expect(result).toMatchObject({ problems: 0, warnings: 0 });
    expect(result.lines.at(-1)).toBe("Everything looks right.");
  });

  it("warns about drafts older than a day and says how to drop them", () => {
    const result = report({ ...healthy, drafts: [
      { editor: "7f822b59-aaaa", entries: ["pages/home", "services/care"], newest: NOW - 3 * 24 * 3_600_000 },
      { editor: "11112222-bbbb", entries: ["pages/about"], newest: NOW - 2 * 3_600_000 },
    ] }, NOW);
    expect(result.warnings).toBe(1);
    const text = result.lines.join("\n");
    expect(text).toContain("⚠ Editor 7f822b59 has 2 unpublished drafts, last saved 3 days ago: pages/home, services/care");
    expect(text).toContain("rm -rf .caret/drafts/7f822b59-aaaa");
    expect(text).toContain("• Editor 11112222 has 1 unpublished draft, last saved 2 hours ago: pages/about");
  });

  it("counts what would break a deploy as problems", () => {
    const result = report({ ...healthy, coreVersion: null, ignoredUploads: true, envNotIgnored: true }, NOW);
    expect(result.problems).toBe(3);
    expect(result.lines.join("\n")).toContain("✗ public/uploads is ignored by Git");
  });

  it("explains uncommitted content by whether Publish commits", () => {
    const uncommitted = [" M src/content/pages/home.md"];
    expect(report({ ...healthy, uncommitted }, NOW).lines.join("\n")).toContain("set CARET_GIT_ON_PUBLISH=true");
    expect(report({ ...healthy, uncommitted, commitsOnPublish: true }, NOW).lines.join("\n")).toContain("Publish asks before it commits");
  });

  it("lists unused uploads, shortened after ten", () => {
    const unusedUploads = Array.from({ length: 12 }, (_, index) => `image-${index}.png`);
    const text = report({ ...healthy, unusedUploads }, NOW).lines.join("\n");
    expect(text).toContain("12 uploaded images aren't used");
    expect(text).toContain("… and 2 more");
  });
});

describe("caretize doctor inspect", () => {
  let dir: string;
  const write = (path: string, content: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-doctor-"));
    write("astro.config.mjs", "import caret from '@caretcms/core';\nexport default { integrations: [caret()] };\n");
    write("node_modules/@caretcms/core/package.json", JSON.stringify({ version: "0.6.3" }));
    write(".gitignore", "node_modules\n.env\n.caret/drafts/\n");
    write(".env", "CARET_SESSION_SECRET=abc\nCARET_GIT_ON_PUBLISH=true\n");
    write("src/content/pages/home.md", '---\ncover: "/uploads/used.png"\n---\n');
    write("public/uploads/used.png", "png");
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds nothing wrong in a clean project", () => {
    expect(inspect(dir)).toEqual({ ...healthy, commitsOnPublish: true });
  });

  it("finds drafts, uncommitted content, unused uploads and ignore mistakes", () => {
    write(".caret/drafts/editor-1/data/pages/home.json", "{}");
    write(".caret/drafts/editor-1/meta/revisions.json", "{}");
    const saved = new Date(NOW - 5 * 24 * 3_600_000);
    utimesSync(join(dir, ".caret/drafts/editor-1/data/pages/home.json"), saved, saved);
    write("src/content/pages/home.md", '---\ncover: "/uploads/used.png"\ntitle: Edited\n---\n');
    write("public/uploads/unused.png", "png");
    write(".caret/drafts/editor-1/data/pages/about.json", '{"cover":"/uploads/in-draft.png"}');
    write("public/uploads/in-draft.png", "png");
    write(".gitignore", "node_modules\n");

    const found = inspect(dir);
    expect(found.drafts).toHaveLength(1);
    expect(found.drafts[0]).toMatchObject({ editor: "editor-1", entries: ["pages/about", "pages/home"] });
    expect(found.uncommitted.some((line) => line.endsWith("src/content/pages/home.md"))).toBe(true);
    expect(found.unusedUploads).toEqual(["unused.png"]);
    expect(found).toMatchObject({ draftsNotIgnored: true, envNotIgnored: true, ignoredUploads: false });
  });

  it("works outside Git and without CaretCMS installed", () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    expect(inspect(dir)).toMatchObject({ git: false, coreVersion: null, uncommitted: [], ignoredUploads: false });
  });
});
