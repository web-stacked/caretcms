import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../../packages/caretize/src/preflight";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "caretize-pf-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function pkg(deps: Record<string, string>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps }));
}
function config(body: string): void {
  writeFileSync(join(dir, "astro.config.mjs"), body);
}

describe("preflight", () => {
  it("errors when it isn't an Astro project", () => {
    pkg({});
    expect(preflight(dir).errors[0]).toMatch(/Astro project/);
  });

  it("passes cleanly when caret() is wired and output is server", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`import caret from "@caretcms/core";\nexport default defineConfig({ output: "server", integrations: [caret()] });`);
    const pf = preflight(dir);
    expect(pf.caretWired).toBe(true);
    expect(pf.outputMode).toBe("server");
    expect(pf.errors).toEqual([]);
    expect(pf.warnings.join(" ")).not.toMatch(/caret\(\) is not|output is/);
  });

  it("warns when @caretcms/core is installed but caret() is not in the config", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`export default defineConfig({ output: "server", integrations: [] });`);
    const pf = preflight(dir);
    expect(pf.caretWired).toBe(false);
    expect(pf.warnings.some((w) => /caret\(\) is not in astro\.config/.test(w))).toBe(true);
  });

  it("warns about static output when CaretCMS is present", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`import caret from "@caretcms/core";\nexport default defineConfig({ output: "static", integrations: [caret()] });`);
    const pf = preflight(dir);
    expect(pf.outputMode).toBe("static");
    expect(pf.warnings.some((w) => /output is "static"/.test(w))).toBe(true);
  });

  it("defaults outputMode to static when unset", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`export default defineConfig({ integrations: [] });`);
    expect(preflight(dir).outputMode).toBe("static");
  });
});
