/**
 * Read-path id validation + collection-id normalization.
 *
 * The mutation engine validates ids before WRITES, but reads arrive straight
 * from `data-caret` attributes via the rewrite engine. Unvalidated reads both
 * join raw segments into filesystem paths and behave differently across
 * platforms: macOS (case-insensitive APFS) resolves `Pages/Home.json` against
 * `pages/home.json`, Linux does not — so an uppercase binding "works" in dev
 * and silently never renders in production. Validation makes the failure
 * consistent everywhere.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { parseMutationCommand } from "../../packages/core/src/runtime/mutations/contracts";

let dir: string;
let adapter: FilesystemAdapter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-idval-"));
  adapter = new FilesystemAdapter({
    dataRoot: join(dir, "data"),
    metaRoot: join(dir, "meta"),
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FilesystemAdapter id validation", () => {
  it("getEntry rejects ids outside the grammar instead of resolving paths", async () => {
    mkdirSync(join(dir, "data", "pages"), { recursive: true });
    writeFileSync(join(dir, "data", "pages", "home.json"), `{"title":"hi"}`);

    expect(await adapter.getEntry("pages", "home")).not.toBeNull();
    // Uppercase must fail here exactly as it would on a case-sensitive deploy.
    expect(await adapter.getEntry("Pages", "Home")).toBeNull();
    expect(await adapter.getEntry("pages", "../home")).toBeNull();
    expect(await adapter.getEntry("..", "home")).toBeNull();
  });

  it("listEntryIds drops file stems outside the grammar", async () => {
    mkdirSync(join(dir, "data", "pages"), { recursive: true });
    writeFileSync(join(dir, "data", "pages", "home.json"), `{}`);
    writeFileSync(join(dir, "data", "pages", "__temp.json"), `{}`);
    writeFileSync(join(dir, "data", "pages", "Draft.json"), `{}`);

    expect(await adapter.listEntryIds("pages")).toEqual(["home"]);
  });

  it("writeEntry refuses an invalid path outright (defense in depth)", async () => {
    await expect(adapter.writeEntry("Pages", "home", {})).rejects.toThrow(
      /invalid entry path/,
    );
  });
});

describe("create_collection id normalization", () => {
  it("normalizes the id like every other command instead of rejecting case", async () => {
    // save_field/delete_collection lowercase via parseCollectionName; before
    // this fix create_collection("Blog") was rejected while saves to "Blog"
    // silently landed in "blog".
    const result = await parseMutationCommand(new InMemoryAdapter(), {
      type: "create_collection",
      id: "  Blog ",
      label: "Blog",
      schema: { type: "object", properties: { title: { type: "string" } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.command.type === "create_collection") {
      expect(result.command.id).toBe("blog");
    }
  });
});
