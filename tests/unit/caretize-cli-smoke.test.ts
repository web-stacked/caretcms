/**
 * End-to-end smoke test for the caretize CLI binary.
 *
 * The other caretize specs unit-test the engine modules directly; this one
 * drives the *real* compiled `dist/cli.js` as a subprocess so cli.ts itself —
 * arg parsing, the non-interactive selection branches, output formatting, and
 * process exit codes — is actually exercised. Each case runs in its own temp
 * project so writes/backups stay isolated.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "packages", "caretize", "dist", "cli.js");

// dist/ is gitignored and built by `npm run check`; build once on demand so a
// standalone `npm run test:unit` still has a binary to run.
beforeAll(() => {
  if (!existsSync(CLI)) execSync("npm run build:caretize", { cwd: ROOT, stdio: "ignore" });
}, 120_000);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in `cwd`. Never throws — non-zero exits are returned, not raised. */
function run(cwd: string, ...args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caretize-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A minimal project preflight accepts (astro.config present) with one taggable page. */
function project(page = "<h1>Hello world</h1>\n"): string {
  write("astro.config.mjs", "export default {};\n");
  write("src/pages/index.astro", page);
  return page;
}

describe("caretize CLI · meta flags", () => {
  it("--help prints usage and exits 0", () => {
    const r = run(dir, "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: npx @caretcms/caretize");
  });

  it("init without a terminal says how to run it instead of quitting silently", () => {
    project();
    const r = run(dir, "init");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("npx @caretcms/caretize init -y");
    // Nothing was changed.
    expect(readFileSync(join(dir, "astro.config.mjs"), "utf8")).toBe("export default {};\n");
  });

  it("--version prints the published package version and exits 0", () => {
    const r = run(dir, "--version");
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages", "caretize", "package.json"), "utf8")) as { version: string };
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(manifest.version);
  });

  it("rejects an unknown flag with exit code 2", () => {
    const r = run(dir, "--nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag: --nope");
  });

  it("refuses a non-interactive run with no directive (exit 2)", () => {
    project();
    const r = run(dir); // no --dry-run / -y / --report, no TTY
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("non-interactive terminal");
  });
});

describe("caretize CLI · scan + apply", () => {
  it("--dry-run reports a plan but writes nothing", () => {
    const original = project();
    const r = run(dir, "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`data-caret="pages::home::`); // index.astro → id "home"
    expect(r.stdout).toContain("(dry run — nothing written)");
    // file untouched
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toBe(original);
  });

  it("--diff previews the before→after and writes nothing", () => {
    const original = project();
    const r = run(dir, "--diff");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/pages/index.astro");
    expect(r.stdout).toContain(`+ <h1 data-caret="pages::home::`); // shows the insertion
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toBe(original); // untouched
  });

  it("--diff --report writes the report artifact but never the source", () => {
    const original = project();
    const r = run(dir, "--diff", "--report", "rep.json");
    expect(r.status).toBe(0);
    // --report is an explicit artifact request → written even under --diff…
    expect(JSON.parse(readFileSync(join(dir, "rep.json"), "utf8"))).toBeTypeOf("object");
    // …but the source file is still untouched (the safety invariant is about source).
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toBe(original);
  });

  it("--diff on an already-tagged project says there's nothing to preview", () => {
    project();
    run(dir, "-y"); // tag everything first
    const r = run(dir, "--diff");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("(no changes to preview)");
  });

  it("-y applies tags, writes a backup, and --restore reverts", () => {
    const original = project();

    const apply = run(dir, "-y");
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("change(s) across");
    // core isn't installed in the temp project → CTA points at init, not "click to edit"
    expect(apply.stdout).toContain("npx @caretcms/caretize init");
    expect(apply.stdout).not.toContain("click to edit");
    const tagged = readFileSync(join(dir, "src/pages/index.astro"), "utf8");
    expect(tagged).toContain(`data-caret="pages::home::`);
    expect(existsSync(join(dir, ".caret", ".caretize-bak"))).toBe(true);

    const restore = run(dir, "--restore");
    expect(restore.status).toBe(0);
    expect(restore.stdout).toContain("restored");
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toBe(original);
  });

  it("--report writes a JSON report", () => {
    project();
    const r = run(dir, "-y", "--report", "caretize-report.json");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("report →");
    const report = JSON.parse(readFileSync(join(dir, "caretize-report.json"), "utf8"));
    expect(report).toBeTypeOf("object");
  });
});

describe("caretize CLI · --all escalation", () => {
  // One page that exercises every opt-in tier at once:
  //   - <h1>           → default high-confidence tag (always)
  //   - posts.map h2   → collection bind (--bind-collections / --all)
  //   - <p>…<strong>   → rich-eligible heading  (--rich / --all)
  //   - <span>         → low-confidence leaf     (--min-confidence low / --all)
  const PAGE = `---
import { getCollection } from "astro:content";
const posts = await getCollection("blog");
---
<h1>Blog index</h1>
<ul>
  {posts.map((post) => <li><h2>{post.data.title}</h2></li>)}
</ul>
<p>Read <strong>more</strong> here</p>
<span>tiny label</span>
`;

  function blogProject(): void {
    write("astro.config.mjs", "export default {};\n");
    write("src/pages/index.astro", PAGE);
  }

  it("-y WITHOUT --all stays conservative — no binds, no rich, no low-confidence (R1 regression guard)", () => {
    blogProject();
    const r = run(dir, "-y");
    expect(r.status).toBe(0);
    const out = readFileSync(join(dir, "src/pages/index.astro"), "utf8");
    // the always-on default tag lands…
    expect(out).toContain(`data-caret="pages::home::`);
    // …but none of the opt-in tiers sneak in without consent:
    expect(out).not.toContain("data-caret={"); // no per-row collection bind
    expect(out).not.toContain("data-caret-rich"); // no rich promotion
    expect(out).not.toMatch(/<span data-caret/); // no low-confidence tag
    // and the summary points at the one flag, not the four-flag incantation
    expect(r.stdout).toContain("--all");
  });

  it("-y --all turns on every tier: collection bind + rich + low-confidence", () => {
    blogProject();
    const r = run(dir, "-y", "--all");
    expect(r.status).toBe(0);
    const out = readFileSync(join(dir, "src/pages/index.astro"), "utf8");
    expect(out).toContain("data-caret={`blog::${post.id}::title`}"); // collection bind
    expect(out).toContain("data-caret-rich"); // rich promotion
    expect(out).toMatch(/<span data-caret="pages::home::/); // low-confidence tag
  });

  it("--everything is an alias for --all", () => {
    blogProject();
    const r = run(dir, "-y", "--everything");
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toContain("data-caret-rich");
  });

  it("re-running --all on an already-tagged tree is a no-op (idempotent)", () => {
    blogProject();
    expect(run(dir, "-y", "--all").status).toBe(0);
    const first = readFileSync(join(dir, "src/pages/index.astro"), "utf8");
    const second = run(dir, "-y", "--all");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("no changes written");
    // the re-run scan frames existing coverage as "already editable"
    expect(second.stdout).toContain("already editable");
    expect(readFileSync(join(dir, "src/pages/index.astro"), "utf8")).toBe(first);
  });
});

describe("caretize on a CaretCMS 0.6 project", () => {
  function project(core: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { astro: "^7", "@caretcms/core": core } }));
    writeFileSync(join(dir, "astro.config.mjs"), `import caret from "@caretcms/core";\nexport default defineConfig({ integrations: [caret()] });\n`);
    mkdirSync(join(dir, "src", "pages"), { recursive: true });
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    writeFileSync(join(dir, "src", "pages", "index.astro"), [
      "---",
      "import { getCollection } from 'astro:content';",
      "const posts = await getCollection('blog');",
      "---",
      "<main><h1>Journal</h1><ul>{posts.map((p) => <li><h2>{p.data.title}</h2></li>)}</ul></main>",
    ].join("\n"));
    writeFileSync(join(dir, "src", "components", "Header.astro"), '<header class="fixed inset-x-0 top-0"><p>Atlas</p></header>\n');
  }

  it("leaves astro:content loops to CaretCMS and points fixed headers at the overlay opt-out", () => {
    project("^0.6.0");
    const r = run(dir, "--dry-run", "-y");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("consider a dynamic collection");
    expect(r.stdout).not.toContain("--bind-collections");
    expect(r.stdout).toContain("src/components/Header.astro has a fixed header or nav");
    expect(r.stdout).toContain('class="caret-studio-overlay"');
  });

  it("keeps the earlier advice for older cores", () => {
    project("^0.5.0");
    const r = run(dir, "--dry-run", "-y");
    expect(r.stdout).toContain("consider a dynamic collection");
    expect(r.stdout).not.toContain("caret-studio-overlay");
  });
});
