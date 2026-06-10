import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";

describe("FilesystemAdapter revision store integrity", () => {
  let workdir: string;
  let metaRoot: string;
  let adapter: FilesystemAdapter;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "alc-fs-corrupt-"));
    metaRoot = join(workdir, "meta");
    adapter = new FilesystemAdapter({
      dataRoot: join(workdir, "data"),
      metaRoot,
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("treats a missing revisions store as revision 0", async () => {
    expect(await adapter.getRevision("pages", "home")).toBe(0);
  });

  it("throws on a corrupt revisions store rather than silently reading 0", async () => {
    await mkdir(metaRoot, { recursive: true });
    await writeFile(join(metaRoot, "revisions.json"), "{ not valid json", "utf8");

    // Silently returning 0 here would let a stale writer clobber newer data.
    await expect(adapter.getRevision("pages", "home")).rejects.toThrow(/corrupt/i);
  });
});
