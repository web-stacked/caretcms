import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../../packages/caretize/src/preflight";
import { selectTiers } from "../../packages/caretize/src/select-policy";
import { offerableCounts, type EscalationCounts } from "../../packages/caretize/src/escalation";
import { formatHints } from "../../packages/caretize/src/output";
import { findFixedChrome, hasFixedChrome } from "../../packages/caretize/src/layout-notes";
import type { FilePlan } from "../../packages/caretize/src/plan";

/**
 * CaretCMS 0.6 binds content read through astro:content on its own, and its
 * Studio drawer moves the page aside. caretize stops offering tiers that
 * duplicate the first, and points fixed headers at the drawer's overlay opt-out.
 */

describe("preflight: does core bind astro:content reads?", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "caretize-core-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function project(core: string, configBody = "integrations: [caret()]", installed?: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { astro: "^7", "@caretcms/core": core } }));
    writeFileSync(join(dir, "astro.config.mjs"), `import caret from "@caretcms/core";\nexport default defineConfig({ ${configBody} });`);
    if (installed) {
      mkdirSync(join(dir, "node_modules/@caretcms/core"), { recursive: true });
      writeFileSync(join(dir, "node_modules/@caretcms/core/package.json"), JSON.stringify({ version: installed }));
    }
  }

  it("is on for a wired 0.6 project", () => {
    project("^0.6.0");
    expect(preflight(dir)).toMatchObject({ core06: true, coreBinds: true });
  });

  it("reads the installed version first, and tarball names", () => {
    project("^0.6.0", undefined, "0.5.0");
    expect(preflight(dir).coreBinds).toBe(false);
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    project("file:../tarballs/caretcms-core-0.6.0.tgz");
    expect(preflight(dir).coreBinds).toBe(true);
  });

  it("is off for older cores, unknown versions, and when turned off in config", () => {
    project("^0.5.0");
    expect(preflight(dir).coreBinds).toBe(false);
    project("workspace:*");
    expect(preflight(dir).coreBinds).toBe(false);
    project("^0.6.0", "integrations: [caret({ bindContent: false })]");
    expect(preflight(dir)).toMatchObject({ core06: true, coreBinds: false });
    project("^0.6.0", "integrations: [caret({ enableInlineEditor: false })]");
    expect(preflight(dir).coreBinds).toBe(false);
  });
});

describe("tiers core already covers", () => {
  it("--all leaves out collections and routes, explicit flags still apply", () => {
    expect([...selectTiers({ all: true, coreBinds: true })].sort()).toEqual(["lowconf", "rich", "rich-class"]);
    expect(selectTiers({ all: true }).has("collections")).toBe(true);
    expect(selectTiers({ coreBinds: true, flags: { collections: true } }).has("collections")).toBe(true);
  });

  it("are never offered in the interactive prompt", () => {
    const counts: EscalationCounts = { collections: 3, routes: 2, rich: 1, "rich-class": 0, lowconf: 0 };
    expect(offerableCounts(counts, new Set(), true)).toMatchObject({ collections: 0, routes: 0, rich: 1 });
    expect(offerableCounts(counts, new Set())).toMatchObject({ collections: 3, routes: 2 });
  });

  it("show as data spots, not as tiers to unlock", () => {
    const plans = [{
      relPath: "src/pages/index.astro", tags: [], belowConfidence: 0,
      skipped: [{ reason: "inside-iterator" }, { reason: "dynamic-content" }],
    } as unknown as FilePlan, {
      relPath: "src/pages/blog/[slug].astro", tags: [], belowConfidence: 0, skipped: [], scopeSkip: "dynamic-route",
    } as unknown as FilePlan];
    const out = formatHints(plans, { coreBinds: true });
    expect(out).not.toContain("dynamic lists");
    expect(out).not.toContain("--bind-collections");
    expect(out).toContain("3 spot(s) render text or images from props or data");
    expect(formatHints(plans, {})).toContain("1 item(s) in dynamic lists");
  });
});

describe("fixed header or nav", () => {
  it("is found from Tailwind classes and <style> rules", () => {
    expect(hasFixedChrome('<header class="fixed inset-x-0 top-0 z-50">')).toBe(true);
    expect(hasFixedChrome('<nav class:list={["fixed top-0", open && "open"]}>')).toBe(true);
    expect(hasFixedChrome("<header class=\"site\"></header><style>\n  .site-header { position: fixed; top: 0; }\n</style>")).toBe(true);
    expect(hasFixedChrome("<style>nav { position:fixed }</style>")).toBe(true);
  });

  it("ignores sticky headers, other fixed elements and look-alike classes", () => {
    expect(hasFixedChrome('<header class="sticky top-0">')).toBe(false);
    expect(hasFixedChrome('<header class="not-fixed">')).toBe(false);
    expect(hasFixedChrome('<div class="fixed bottom-4 right-4">Chat</div>')).toBe(false);
    expect(hasFixedChrome("<style>.toast { position: fixed }</style>")).toBe(false);
  });

  it("names the templates and points at caret-studio-overlay", () => {
    const sources: Record<string, string> = {
      "src/components/Header.astro": '<header class="fixed top-0">',
      "src/pages/index.astro": "<main />",
    };
    const found = findFixedChrome(Object.keys(sources), (rel) => sources[rel] ?? null);
    expect(found).toEqual(["src/components/Header.astro"]);
    const out = formatHints([], { fixedChrome: found });
    expect(out).toContain("src/components/Header.astro has a fixed header or nav");
    expect(out).toContain('class="caret-studio-overlay"');
  });
});
