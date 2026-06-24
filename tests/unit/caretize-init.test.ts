import { describe, it, expect } from "vitest";
import {
  freshConfig,
  findConfigObjectBrace,
  planConfigWiring,
  renderEnvAdditions,
  type WiringNeeds,
} from "../../packages/caretize/src/init";

const SERVER_ALL: WiringNeeds = { caret: true, adapter: true, output: true, staticDelivery: false };
const STATIC_ALL: WiringNeeds = { caret: true, adapter: false, output: false, staticDelivery: true };

describe("freshConfig", () => {
  it("defaults to static delivery config", () => {
    const c = freshConfig();
    expect(c).toMatch(/import caret from '@caretcms\/core';/);
    expect(c).toMatch(/delivery: "static"/);
    expect(c).not.toMatch(/@astrojs\/node/);
    expect(c).not.toMatch(/output: 'server'/);
    expect(c).not.toMatch(/adapter:/);
  });

  it("can render a complete server-mode config", () => {
    const c = freshConfig("server");
    expect(c).toMatch(/import caret from '@caretcms\/core';/);
    expect(c).toMatch(/import node from '@astrojs\/node';/);
    expect(c).toMatch(/output: 'server'/);
    expect(c).toMatch(/adapter: node\(\{ mode: 'standalone' \}\)/);
    expect(c).toMatch(/integrations: \[caret\(\)\]/);
  });
});

describe("findConfigObjectBrace", () => {
  it("locates the defineConfig object brace", () => {
    const src = `export default defineConfig({ output: 'static' });`;
    const idx = findConfigObjectBrace(src)!;
    expect(src[idx]).toBe("{");
  });
  it("locates a bare export-default object brace", () => {
    const src = `export default {\n  integrations: [],\n};`;
    const idx = findConfigObjectBrace(src)!;
    expect(src[idx]).toBe("{");
  });
  it("returns null for an unrecognized shape", () => {
    expect(findConfigObjectBrace(`const x = 1;`)).toBeNull();
  });
});

describe("planConfigWiring", () => {
  it("wires everything into a minimal config and stays a pure insertion", () => {
    const src = `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n`;
    const r = planConfigWiring(src, SERVER_ALL);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/import caret from '@caretcms\/core';/);
    expect(r.output).toMatch(/import node from '@astrojs\/node';/);
    expect(r.output).toMatch(/output: 'server',/);
    expect(r.output).toMatch(/adapter: node\(\{ mode: 'standalone' \}\)/);
    expect(r.output).toMatch(/integrations: \[caret\(\)\]/);
    // pure insertion: every original char survives, in order
    expect(stripped(r.output, src)).toBe(true);
  });

  it("adds caret() into an existing integrations array without clobbering it", () => {
    const src = `import { defineConfig } from 'astro/config';\nimport tailwind from '@tailwindcss/vite';\n\nexport default defineConfig({\n  output: 'server',\n  adapter: x,\n  integrations: [tailwind()],\n});\n`;
    const r = planConfigWiring(src, { caret: true, adapter: false, output: false, staticDelivery: false });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/integrations: \[caret\(\), tailwind\(\)\]/);
    // didn't touch the adapter or output the project already had
    expect(r.output).not.toMatch(/adapter: node/);
    expect(stripped(r.output, src)).toBe(true);
  });

  it("inserts caret() into an empty integrations array with no dangling comma", () => {
    const src = `export default defineConfig({\n  output: 'server',\n  adapter: x,\n  integrations: [],\n});\n`;
    const r = planConfigWiring(src, { caret: true, adapter: false, output: false, staticDelivery: false });
    expect(r.output).toMatch(/integrations: \[caret\(\)\]/);
    expect(r.output).not.toMatch(/caret\(\), \]/);
  });

  it("wires static delivery into a minimal static config without server adapter", () => {
    const src = `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n`;
    const r = planConfigWiring(src, STATIC_ALL);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/import caret from '@caretcms\/core';/);
    expect(r.output).toMatch(/integrations: \[caret\(\{ delivery: "static" \}\)\]/);
    expect(r.output).not.toMatch(/@astrojs\/node/);
    expect(r.output).not.toMatch(/output: 'server'/);
    expect(r.output).not.toMatch(/adapter:/);
    expect(stripped(r.output, src)).toBe(true);
  });

  it("adds static delivery into an existing caret() call by insertion", () => {
    const src = `import caret from '@caretcms/core';\n\nexport default defineConfig({ integrations: [caret()] });\n`;
    const r = planConfigWiring(src, { caret: false, adapter: false, output: false, staticDelivery: true });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/caret\(\{ delivery: "static" \}\)/);
    expect(stripped(r.output, src)).toBe(true);
  });

  it("flags an existing non-server output as manual rather than rewriting it", () => {
    const src = `export default defineConfig({\n  output: 'static',\n});\n`;
    const r = planConfigWiring(src, { caret: false, adapter: false, output: true, staticDelivery: false });
    expect(r.output).toBe(src); // nothing inserted
    expect(r.manual.join(" ")).toMatch(/set output to 'server'/);
  });

  it("falls back (ok:false) on an unrecognized config shape", () => {
    const r = planConfigWiring(`const config = makeIt();`, SERVER_ALL);
    expect(r.ok).toBe(false);
    expect(r.output).toBe(`const config = makeIt();`);
  });

  it("does not duplicate an import it already has", () => {
    const src = `import caret from '@caretcms/core';\n\nexport default defineConfig({ integrations: [] });\n`;
    const r = planConfigWiring(src, { caret: true, adapter: false, output: false, staticDelivery: false });
    expect(r.output.match(/@caretcms\/core/g)!.length).toBe(1);
  });
});

describe("renderEnvAdditions", () => {
  it("scaffolds both secrets into an empty .env", () => {
    const { append, added } = renderEnvAdditions("", "deadbeef");
    expect(append).toMatch(/CARET_SESSION_SECRET=deadbeef/);
    expect(append).toMatch(/# CARET_EDIT_PASSWORD=/);
    expect(added.length).toBe(2);
  });

  it("is idempotent — never re-adds an existing key (even commented)", () => {
    const existing = `CARET_SESSION_SECRET=abc\n# CARET_EDIT_PASSWORD=hunter2\n`;
    const { append, added } = renderEnvAdditions(existing, "new");
    expect(append).toBe("");
    expect(added.length).toBe(0);
  });

  it("inserts a separating newline when the file lacks a trailing one", () => {
    const { append } = renderEnvAdditions("FOO=bar", "s");
    expect(append.startsWith("\n")).toBe(true);
  });
});

/** True when `original` is a subsequence of `out` (out only inserted chars). */
function stripped(out: string, original: string): boolean {
  let i = 0;
  for (let j = 0; j < out.length && i < original.length; j++) {
    if (out[j] === original[i]) i++;
  }
  return i === original.length;
}
