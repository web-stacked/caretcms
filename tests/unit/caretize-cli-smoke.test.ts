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
    expect(r.stdout).toContain("Usage: caretize");
  });

  it("--version prints the version and exits 0", () => {
    const r = run(dir, "--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
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

  it("-y applies tags, writes a backup, and --restore reverts", () => {
    const original = project();

    const apply = run(dir, "-y");
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("change(s) across");
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
