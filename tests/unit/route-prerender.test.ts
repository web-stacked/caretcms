import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runtime route prerender flags", () => {
  it("opts injected CMS routes out of static prerendering", async () => {
    const routesDir = join(process.cwd(), "packages/core/src/runtime/routes");
    const files = (await readdir(routesDir))
      .filter((file) => file.endsWith(".ts") && file !== "_helpers.ts")
      .sort();

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(join(routesDir, file), "utf8");
      expect(source, file).toContain("export const prerender = false;");
    }
  });
});
