import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EN_STUDIO_MESSAGES, ES_STUDIO_MESSAGES } from "../../packages/core/src/runtime/i18n";
import { t, tHtml } from "../../packages/core/static/cms/editor/i18n.js";

const STATIC_ROOT = fileURLToPath(new URL("../../packages/core/static/cms/", import.meta.url));
const EN: Record<string, string> = EN_STUDIO_MESSAGES;
const ES: Record<string, string | undefined> = ES_STUDIO_MESSAGES;

function scripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return scripts(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

/**
 * Every literal key passed to t() or tHtml() in the browser scripts, and every
 * quoted `editor.*` key (as in `t(one ? 'editor.a.one' : 'editor.a.other')`),
 * with where it's used.
 */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of scripts(STATIC_ROOT)) {
    const source = readFileSync(file, "utf8");
    const calls = source.matchAll(/\bt(?:Html)?\(\s*(['"])([^'"]+)\1/g);
    const quoted = source.matchAll(/(['"])(editor\.\w+\.[\w.]+)\1/g);
    for (const match of [...calls, ...quoted]) keys.set(match[2], relative(STATIC_ROOT, file));
  }
  return keys;
}

const placeholders = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const editorKeys = (dictionary: Record<string, unknown>) => Object.keys(dictionary).filter((key) => key.startsWith("editor."));

describe("on-page editor messages", () => {
  it("finds the editor's keys in the browser scripts", () => {
    const keys = usedKeys();
    expect(keys.size).toBeGreaterThan(200);
    expect(keys.get("editor.toolbar.publish")).toBe("editor/toolbar.js");
    expect(keys.get("editor.session.title")).toBe("editor/session-recovery.js");
    expect(keys.get("editor.toolbar.signOutKeepOther")).toBe("editor/toolbar.js");
  });

  it("has every key the scripts use, in English and Spanish", () => {
    const missingEn: string[] = [];
    const missingEs: string[] = [];
    for (const [key, file] of usedKeys()) {
      if (!(key in EN)) missingEn.push(`${key} (${file})`);
      if (!ES[key]) missingEs.push(`${key} (${file})`);
    }
    expect(missingEn).toEqual([]);
    expect(missingEs).toEqual([]);
  });

  it("translates every editor key into Spanish, and nothing English lacks", () => {
    expect(editorKeys(EN).filter((key) => !ES[key])).toEqual([]);
    expect(editorKeys(ES).filter((key) => !(key in EN))).toEqual([]);
  });

  it("keeps the same placeholders in both languages", () => {
    const mismatched = editorKeys(EN)
      .filter((key) => ES[key] !== undefined)
      .filter((key) => placeholders(EN[key]).join() !== placeholders(ES[key]!).join());
    expect(mismatched).toEqual([]);
  });

  it("leaves no session keys outside the editor's", () => {
    expect(Object.keys(EN).filter((key) => key.startsWith("session."))).toEqual([]);
    expect(Object.keys(ES).filter((key) => key.startsWith("session."))).toEqual([]);
  });
});

describe("t()", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(t("editor.toolbar.changesOther", { count: 3 })).toBe("3 unpublished changes");
    expect(t("editor.toolbar.changesOther")).toBe("{count} unpublished changes");
    expect(t("editor.publish.namesTwo", { first: "“A”" })).toBe("“A” and {second}");
    expect(t("editor.publish.namesMore", { first: "a", second: "b", count: 0 })).toBe("a, b and 0 more");
  });

  it("falls back to the key for a message it doesn't have", () => {
    expect(t("editor.nope")).toBe("editor.nope");
  });

  it("escapes a message for HTML with tHtml()", () => {
    expect(tHtml("editor.publish.entryNamed", { title: `<b class="x">&'` })).toBe("“&lt;b class=&quot;x&quot;&gt;&amp;&#39;”");
  });
});

describe("the editor messages route", () => {
  const GLOBALS = [
    "__ASTRO_CARET_MOUNT_PATH__",
    "__ASTRO_CARET_API_BASE_PATH__",
    "__ASTRO_CARET_EDITOR_HOME__",
    "__ASTRO_CARET_MODE__",
    "__ASTRO_CARET_THEME_CONFIG__",
    "__ASTRO_CARET_BRAND_CONFIG__",
    "__ASTRO_CARET_INLINE_EDITOR__",
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** What /__caret/editor/messages.js serves for a site configured with `locale` and `dictionary`. */
  async function served(locale: string, dictionary?: Record<string, string>): Promise<Record<string, string>> {
    for (const name of GLOBALS) vi.stubGlobal(name, undefined);
    vi.stubGlobal("__ASTRO_CARET_LOCALE__", locale);
    vi.stubGlobal("__ASTRO_CARET_DICTIONARY__", dictionary ? JSON.stringify(dictionary) : undefined);
    vi.resetModules();
    const { GET } = await import("../../packages/core/src/runtime/routes/editor-assets");
    const response = await GET({ params: { path: "editor/messages.js" }, request: new Request("http://localhost/__caret/editor/messages.js") } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    const body = await response.text();
    expect(body.startsWith("export default {")).toBe(true);
    return JSON.parse(body.slice("export default ".length).trim().replace(/;$/, ""));
  }

  it("serves Spanish to a Spanish site", async () => {
    const messages = await served("es");
    expect(messages["editor.toolbar.edit"]).toBe("Editar");
    expect(messages["editor.session.title"]).toBe("Vuelve a iniciar sesión");
    expect(Object.keys(messages).every((key) => key.startsWith("editor."))).toBe(true);
    expect(Object.keys(messages).sort()).toEqual(editorKeys(EN).sort());
  });

  it("serves English by default, with a site's dictionary on top", async () => {
    const messages = await served("en", { ...EN_STUDIO_MESSAGES, "editor.toolbar.edit": "Write</script>" });
    expect(messages["editor.toolbar.preview"]).toBe("Preview");
    expect(messages["editor.toolbar.edit"]).toBe("Write</script>");
  });
});
