import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { caret, filesystemStorage } from "../../packages/core/src/index";

// The resolved id Astro's Vite plugin layer asks for; the providers virtual
// module bakes the chosen storage adapter's entrypoint into its source.
const RESOLVED_PROVIDERS_ID = "\0virtual:caretcms/providers";
const MARKDOWN_ENTRYPOINT = "@caretcms/core/providers/storage/markdown";
const FILESYSTEM_ENTRYPOINT = "@caretcms/core/providers/storage/filesystem";

/**
 * Run `caret()`'s `astro:config:setup` hook against a stub Astro context and
 * return the generated `virtual:caretcms/providers` source — the string that
 * decides which StorageAdapter the Studio loads at runtime.
 */
function resolveProvidersSource(
  rootDir: string,
  options: Parameters<typeof caret>[0] = {},
): string {
  const integration = caret(options);
  let providersSource = "";

  const noop = () => {};
  integration.hooks["astro:config:setup"]!({
    command: "build",
    config: { output: "server", root: pathToFileURL(`${rootDir}/`) },
    logger: { info: noop, warn: noop },
    addMiddleware: noop,
    injectRoute: noop,
    injectScript: noop,
    addDevToolbarApp: noop,
    updateConfig: (cfg: { vite?: { plugins?: unknown[] } }) => {
      const plugins = (cfg.vite?.plugins ?? []) as Array<{
        name?: string;
        load?: (id: string) => string | null;
      }>;
      const providers = plugins.find((p) => p.name === "caretcms:runtime-providers");
      providersSource = providers?.load?.(RESOLVED_PROVIDERS_ID) ?? "";
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return providersSource;
}

describe("zero-config content-collection storage detection", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "caret-detect-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function seedCollections(...names: string[]): Promise<void> {
    for (const name of names) {
      await mkdir(join(workdir, "src", "content", name), { recursive: true });
    }
  }

  it("defaults to markdownStorage when src/content has collections", async () => {
    await seedCollections("blog", "authors");
    const source = resolveProvidersSource(workdir);
    expect(source).toContain(MARKDOWN_ENTRYPOINT);
    expect(source).not.toContain(FILESYSTEM_ENTRYPOINT);
  });

  it("keeps filesystemStorage when src/content is absent", async () => {
    const source = resolveProvidersSource(workdir);
    expect(source).toContain(FILESYSTEM_ENTRYPOINT);
    expect(source).not.toContain(MARKDOWN_ENTRYPOINT);
  });

  it("keeps filesystemStorage when src/content exists but holds no collections", async () => {
    await mkdir(join(workdir, "src", "content"), { recursive: true });
    const source = resolveProvidersSource(workdir);
    expect(source).toContain(FILESYSTEM_ENTRYPOINT);
    expect(source).not.toContain(MARKDOWN_ENTRYPOINT);
  });

  it("does not override an explicit storage choice (filesystemStorage is the opt-out)", async () => {
    await seedCollections("blog");
    const source = resolveProvidersSource(workdir, { storage: filesystemStorage() });
    expect(source).toContain(FILESYSTEM_ENTRYPOINT);
    expect(source).not.toContain(MARKDOWN_ENTRYPOINT);
  });

  it("ignores non-collection-named directories (e.g. a leading-dot dir)", async () => {
    await mkdir(join(workdir, "src", "content", ".cache"), { recursive: true });
    const source = resolveProvidersSource(workdir);
    expect(source).toContain(FILESYSTEM_ENTRYPOINT);
    expect(source).not.toContain(MARKDOWN_ENTRYPOINT);
  });
});
