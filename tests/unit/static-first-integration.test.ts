import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caret } from "../../packages/core/src/index";

function runSetup({
  command,
  output,
  options,
  rootDir,
}: {
  command: "dev" | "build";
  output: "static" | "server";
  options?: Parameters<typeof caret>[0];
  rootDir: string;
}) {
  const integration = caret(options ?? {});
  const calls = {
    middleware: 0,
    routes: [] as string[],
    scripts: 0,
    info: [] as string[],
    warn: [] as string[],
  };
  const noop = () => {};

  integration.hooks["astro:config:setup"]!({
    command,
    config: { output, root: pathToFileURL(`${rootDir}/`) },
    logger: {
      info: (message: string) => calls.info.push(message),
      warn: (message: string) => calls.warn.push(message),
    },
    addMiddleware: () => {
      calls.middleware += 1;
    },
    injectRoute: (route: { pattern: string }) => {
      calls.routes.push(route.pattern);
    },
    injectScript: () => {
      calls.scripts += 1;
    },
    addDevToolbarApp: noop,
    updateConfig: noop,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return calls;
}

describe("static delivery integration setup", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "caret-static-delivery-"));
    vi.stubEnv("CARET_EDIT_PASSWORD", "secret");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("keeps the existing static-output guard when static delivery is disabled", () => {
    const calls = runSetup({ command: "build", output: "static", rootDir });

    expect(calls.middleware).toBe(0);
    expect(calls.routes).toEqual([]);
    expect(calls.warn.join("\n")).toContain("needs Astro server output");
  });

  it("skips authoring routes during static builds when static delivery is enabled", () => {
    const calls = runSetup({
      command: "build",
      output: "static",
      rootDir,
      options: { delivery: "static" },
    });

    expect(calls.middleware).toBe(0);
    expect(calls.routes).toEqual([]);
    expect(calls.info.join("\n")).toContain("static delivery enabled");
  });

  it("injects local authoring routes during static delivery dev", () => {
    const calls = runSetup({
      command: "dev",
      output: "static",
      rootDir,
      options: { delivery: "static" },
    });

    expect(calls.middleware).toBe(1);
    expect(calls.routes).toContain("/api/cms/mutate");
    expect(calls.routes).toContain("/api/cms/publish");
    expect(calls.routes).toContain("/__caret/[...path]");
    expect(calls.info.join("\n")).toContain("static delivery dev authoring enabled");
  });
});
