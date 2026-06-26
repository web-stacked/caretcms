/**
 * Preflight: cheap sanity checks before scanning. Tagging works perfectly yet
 * nothing is editable if CaretCMS isn't actually wired into the project, so we
 * surface that up front. Git cleanliness is advisory — git is the real undo.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface Preflight {
  isAstroProject: boolean;
  hasCaretCore: boolean;
  /** caret() actually referenced in astro.config (not just installed). */
  caretWired: boolean;
  /** Output mode parsed from astro.config: "server" | "hybrid" | "static". */
  outputMode: string;
  /** Static delivery is available either explicitly or via caret()'s auto default. */
  staticDeliveryConfigured: boolean;
  gitRepo: boolean;
  gitClean: boolean | null; // null when not a git repo
  errors: string[];
  notes: string[];
  warnings: string[];
}

function readPkg(rootDir: string): Record<string, unknown> | null {
  const p = resolve(rootDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deps(pkg: Record<string, unknown> | null): Record<string, string> {
  if (!pkg) return {};
  return {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
}

function findAstroConfig(rootDir: string): string | null {
  try {
    const name = readdirSync(rootDir).find((f) => /^astro\.config\.(m?[jt]s|cjs)$/.test(f));
    return name ? resolve(rootDir, name) : null;
  } catch {
    return null;
  }
}

function readConfig(rootDir: string): string | null {
  const path = findAstroConfig(rootDir);
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function preflight(rootDir: string): Preflight {
  const pkg = readPkg(rootDir);
  const d = deps(pkg);
  const config = readConfig(rootDir);

  const isAstroProject = "astro" in d || config !== null;
  const hasCaretCore = "@caretcms/core" in d;

  // caret() is wired only if the config actually references it (imports the
  // package or calls caret(...) in the integrations array).
  const caretWired =
    config !== null && (/\bcaret\s*\(/.test(config) || /@caretcms\/core/.test(config));

  // Output mode (Astro defaults to "static" when unset). "hybrid" was removed
  // in Astro 5 — a config still carrying it is treated as unknown/static so
  // the warning below points the user at a mode that exists.
  const outputMatch = config?.match(/output\s*:\s*["'](server|static)["']/);
  const outputMode = outputMatch ? outputMatch[1] : "static";
  const deliveryConfigured = config !== null && /delivery\s*:/.test(config);
  const deliveryServerConfigured =
    config !== null &&
    /delivery\s*:\s*(?:(["'])server\1|\{[^}]*mode\s*:\s*(["'])server\2)/s.test(config);
  const deliveryStaticOrAutoConfigured =
    config !== null &&
    /delivery\s*:\s*(?:(["'])(?:static|auto)\1|\{[^}]*mode\s*:\s*(["'])(?:static|auto)\2)/s.test(config);
  const staticDeliveryConfigured =
    config !== null &&
    caretWired &&
    !deliveryServerConfigured &&
    (!deliveryConfigured || deliveryStaticOrAutoConfigured);

  let gitRepo = false;
  let gitClean: boolean | null = null;
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    gitRepo = true;
    gitClean = out.trim() === "";
  } catch {
    gitRepo = false;
  }

  const errors: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  if (!isAstroProject) {
    errors.push("This does not look like an Astro project (no astro dependency or astro.config).");
  }
  if (!hasCaretCore) {
    warnings.push(
      "@caretcms/core is not installed — tags will be added, but nothing is editable until CaretCMS is set up.",
    );
  } else if (!caretWired) {
    warnings.push(
      "@caretcms/core is installed but caret() is not in astro.config — tags will be inert until you add it to integrations.",
    );
  }
  if (hasCaretCore && outputMode === "static" && staticDeliveryConfigured) {
    notes.push(
      `static output detected — CaretCMS will use static delivery automatically. Public changes become live after Publish triggers a rebuild and HTML is baked.`,
    );
  } else if (hasCaretCore && outputMode === "static" && deliveryServerConfigured) {
    warnings.push(
      `output is "static" but CaretCMS delivery is "server" — use delivery: "auto" or remove the delivery option to bake static HTML, or switch Astro to output: "server" with an SSR adapter.`,
    );
  } else if (hasCaretCore && outputMode === "static") {
    warnings.push(
      `output is "static" — run caretize init to add caret(); CaretCMS will use automatic static delivery, or use output: "server" plus an SSR adapter for server delivery.`,
    );
  }
  if (gitRepo && gitClean === false) {
    warnings.push("Working tree has uncommitted changes — commit first so you can `git checkout` to undo.");
  }

  return {
    isAstroProject,
    hasCaretCore,
    caretWired,
    outputMode,
    staticDeliveryConfigured,
    gitRepo,
    gitClean,
    errors,
    notes,
    warnings,
  };
}
