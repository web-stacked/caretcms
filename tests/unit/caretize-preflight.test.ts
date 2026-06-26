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
    expect(pf.notes).toEqual([]);
  });

  it("warns when @caretcms/core is installed but caret() is not in the config", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`export default defineConfig({ output: "server", integrations: [] });`);
    const pf = preflight(dir);
    expect(pf.caretWired).toBe(false);
    expect(pf.warnings.some((w) => /caret\(\) is not in astro\.config/.test(w))).toBe(true);
  });

  it("treats static output plus caret() as auto static delivery", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`import caret from "@caretcms/core";\nexport default defineConfig({ output: "static", integrations: [caret()] });`);
    const pf = preflight(dir);
    expect(pf.outputMode).toBe("static");
    expect(pf.staticDeliveryConfigured).toBe(true);
    expect(pf.warnings.join(" ")).not.toContain("auto/static delivery enabled");
    expect(pf.notes.join(" ")).toContain("static output detected");
    expect(pf.notes.join(" ")).toContain("static delivery automatically");
  });

  it("recognizes explicit static delivery output and explains the rebuild boundary", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`import caret from "@caretcms/core";\nexport default defineConfig({ output: "static", integrations: [caret({ delivery: "static" })] });`);
    const pf = preflight(dir);
    expect(pf.outputMode).toBe("static");
    expect(pf.staticDeliveryConfigured).toBe(true);
    expect(pf.notes.join(" ")).toContain("static delivery automatically");
    expect(pf.notes.join(" ")).toContain("rebuild");
  });

  it("warns when static output explicitly selects server delivery", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`import caret from "@caretcms/core";\nexport default defineConfig({ output: "static", integrations: [caret({ delivery: "server" })] });`);
    const pf = preflight(dir);
    expect(pf.staticDeliveryConfigured).toBe(false);
    expect(pf.warnings.join(" ")).toContain('delivery is "server"');
  });

  it("defaults outputMode to static when unset", () => {
    pkg({ astro: "^6", "@caretcms/core": "^0.1.0" });
    config(`export default defineConfig({ integrations: [] });`);
    expect(preflight(dir).outputMode).toBe("static");
  });
});
