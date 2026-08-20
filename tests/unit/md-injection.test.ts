import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caret, markdownStorage, filesystemStorage } from "../../packages/core/src/index";

/**
 * Invoke the config:setup hook with a chosen markdown processor and capture
 * both the (possibly mutated) `mdastPlugins` array and every `updateConfig`
 * patch, so we can assert which pipeline branch the injection took.
 */
function runSetup(opts: {
  options?: Parameters<typeof caret>[0];
  processor?: { name: string; options?: { mdastPlugins?: unknown[] } };
  rootDir: string;
}) {
  const integration = caret(opts.options ?? {});
  const patches: Array<Record<string, unknown>> = [];
  const info: string[] = [];
  const warnings: string[] = [];
  const noop = () => {};
  const markdown = opts.processor ? { processor: opts.processor } : {};

  integration.hooks["astro:config:setup"]!({
    command: "build",
    config: { output: "server", root: pathToFileURL(`${opts.rootDir}/`), markdown },
    logger: { info: (m: string) => info.push(m), warn: (m: string) => warnings.push(m) },
    addMiddleware: noop,
    injectRoute: noop,
    injectScript: noop,
    addDevToolbarApp: noop,
    updateConfig: (p: Record<string, unknown>) => patches.push(p),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const remarkPatch = patches.find(
    (p) => (p.markdown as { remarkPlugins?: unknown[] } | undefined)?.remarkPlugins,
  );
  return {
    info,
    warnings,
    mdastPlugins: opts.processor?.options?.mdastPlugins ?? null,
    remarkPlugins:
      (remarkPatch?.markdown as { remarkPlugins?: unknown[] } | undefined)?.remarkPlugins ?? null,
  };
}

describe("markdown body-editing injection", () => {
  let rootDir: string;
  const storage = () => markdownStorage({ contentRoot: "/project/src/content" });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "caret-md-inject-"));
    vi.stubEnv("CARET_EDIT_PASSWORD", "secret");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("pushes an mdast plugin onto a Sätteri processor (no replacement)", () => {
    const r = runSetup({
      options: { storage: storage() },
      processor: { name: "satteri", options: { mdastPlugins: [] } },
      rootDir,
    });
    expect(r.mdastPlugins).toHaveLength(1);
    expect(r.remarkPlugins).toBeNull(); // never falls back to remark
    expect(r.info.some((m) => /body editing enabled.*Sätteri/i.test(m))).toBe(true);
  });

  it("falls back to a remark plugin when there is no Sätteri processor", () => {
    const r = runSetup({ options: { storage: storage() }, rootDir });
    expect(r.remarkPlugins).toHaveLength(1);
    expect(r.info.some((m) => /body editing enabled.*remark/i.test(m))).toBe(true);
  });

  it("uses remark for a non-Sätteri (unified) processor", () => {
    const r = runSetup({
      options: { storage: storage() },
      processor: { name: "unified", options: { mdastPlugins: [] } },
      rootDir,
    });
    expect(r.mdastPlugins).toHaveLength(0); // unified's array untouched
    expect(r.remarkPlugins).toHaveLength(1);
  });

  it("does nothing when bodyEditing is false", () => {
    const r = runSetup({
      options: { storage: storage(), bodyEditing: false },
      processor: { name: "satteri", options: { mdastPlugins: [] } },
      rootDir,
    });
    expect(r.mdastPlugins).toHaveLength(0);
    expect(r.remarkPlugins).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("does nothing for non-markdown storage", () => {
    const r = runSetup({
      options: { storage: filesystemStorage() },
      processor: { name: "satteri", options: { mdastPlugins: [] } },
      rootDir,
    });
    expect(r.mdastPlugins).toHaveLength(0);
    expect(r.remarkPlugins).toBeNull();
  });
});
