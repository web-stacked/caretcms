import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCaretEnvFiles } from "../../packages/core/src/index";

describe("loadCaretEnvFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caret-env-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads only CARET_ keys, with later env files winning", async () => {
    await writeFile(join(root, ".env"), "CARET_SESSION_SECRET=base\nCARET_EDIT_PASSWORD=\"from env\"\nDATABASE_URL=postgres://x\n# CARET_TRUST_PROXY=1\n");
    await writeFile(join(root, ".env.development.local"), "CARET_SESSION_SECRET=local\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadCaretEnvFiles(root, "development", env).sort()).toEqual(["CARET_EDIT_PASSWORD", "CARET_SESSION_SECRET"]);
    expect(env).toEqual({ CARET_SESSION_SECRET: "local", CARET_EDIT_PASSWORD: "from env" });
  });

  it("never overrides the real environment and ignores other modes", async () => {
    await writeFile(join(root, ".env"), "CARET_SESSION_SECRET=file\nCARET_EDIT_PASSWORD=file\n");
    await writeFile(join(root, ".env.production"), "CARET_TRUST_PROXY=1\n");
    const env: NodeJS.ProcessEnv = { CARET_SESSION_SECRET: "real", CARET_EDIT_PASSWORD: "" };
    loadCaretEnvFiles(root, "development", env);
    expect(env).toEqual({ CARET_SESSION_SECRET: "real", CARET_EDIT_PASSWORD: "file" });
  });

  it("does nothing without env files", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadCaretEnvFiles(root, "development", env)).toEqual([]);
    expect(env).toEqual({});
  });
});
