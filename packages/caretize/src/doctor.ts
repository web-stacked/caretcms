/**
 * `caretize doctor`: check a project that already uses CaretCMS and say, in
 * plain terms, what would surprise its developer: drafts nobody published,
 * content Git doesn't have, images nothing uses, files Git would or wouldn't
 * commit. It reads files and asks Git; it changes nothing.
 *
 * `inspect` gathers the facts and `report` words them, so both can be tested
 * without a terminal.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface DraftSet {
  /** The editor id the drafts belong to (a folder under `.caret/drafts`). */
  editor: string;
  /** Entries this editor has a draft of, as `collection/id`. */
  entries: string[];
  /** When the newest of them was last saved (ms since epoch). */
  newest: number;
}

export interface Inspection {
  /** Installed `@caretcms/core` version, or null when it isn't installed. */
  coreVersion: string | null;
  /** The astro.config file, or null when the project has none. */
  configName: string | null;
  /** Whether that config uses `@caretcms/core`. */
  configWired: boolean;
  drafts: DraftSet[];
  /** Whether the project is a Git work tree. */
  git: boolean;
  /** Content files and uploads Git hasn't committed (porcelain lines). */
  uncommitted: string[];
  /** Whether publishes are committed to Git (`CARET_GIT_ON_PUBLISH=true` in `.env`). */
  commitsOnPublish: boolean;
  /** Paths Git ignores though they must be committed, or doesn't ignore though they must stay private. */
  ignoredUploads: boolean;
  draftsNotIgnored: boolean;
  envNotIgnored: boolean;
  /** Uploaded images no content file, draft or template mentions. */
  unusedUploads: string[];
  /**
   * Content collections whose Zod schema is `.strict()` and doesn't declare
   * `__caret_template__`, while content files carry it: the build fails.
   */
  strictSchemaRisk: boolean;
  /** `.env` has no session secret, or still has the placeholder password. */
  missingSecret: boolean;
  placeholderPassword: boolean;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Whether Git ignores a path. A path that doesn't exist yet is still answered by the ignore rules. */
function ignored(root: string, path: string): boolean {
  return git(root, ["check-ignore", "-q", path]) !== null;
}

function readDrafts(root: string): DraftSet[] {
  const draftsDir = resolve(root, ".caret", "drafts");
  if (!existsSync(draftsDir)) return [];
  const sets: DraftSet[] = [];
  for (const editor of readdirSync(draftsDir)) {
    const data = join(draftsDir, editor, "data");
    const files = walk(data).filter((file) => file.endsWith(".json"));
    if (!files.length) continue;
    sets.push({
      editor,
      entries: files.map((file) => relative(data, file).split("\\").join("/").replace(/\.json$/, "")).sort(),
      newest: Math.max(...files.map((file) => statSync(file).mtimeMs)),
    });
  }
  return sets.sort((a, b) => a.editor.localeCompare(b.editor));
}

function readEnv(root: string): Record<string, string> {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Uploaded images that nothing in the project's content, drafts or source mentions by name. */
function findUnusedUploads(root: string): string[] {
  const uploads = resolve(root, "public", "uploads");
  const files = existsSync(uploads) ? readdirSync(uploads).filter((name) => statSync(join(uploads, name)).isFile()) : [];
  if (!files.length) return [];
  const haystack = [resolve(root, "src"), resolve(root, ".caret", "drafts"), resolve(root, ".caret", "data")]
    .flatMap(walk)
    .filter((file) => /\.(md|mdx|json|ya?ml|astro|html|ts|js|mjs)$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  return files.filter((name) => !haystack.includes(`/uploads/${name}`)).sort();
}

/** A strict content schema that would reject the template-text record content files carry. */
function findStrictSchemaRisk(root: string): boolean {
  const config = ["src/content.config.ts", "src/content.config.mjs", "src/content.config.js", "src/content/config.ts", "src/content/config.mjs"]
    .map((path) => resolve(root, path)).find(existsSync);
  if (!config) return false;
  const source = readFileSync(config, "utf8");
  if (!/\.strict\s*\(/.test(source) || source.includes("__caret_template__")) return false;
  return walk(resolve(root, "src", "content")).some((file) => /\.(md|mdx|json|ya?ml)$/.test(file) && readFileSync(file, "utf8").includes("__caret_template__"));
}

export function inspect(root: string): Inspection {
  const corePkg = resolve(root, "node_modules", "@caretcms", "core", "package.json");
  let coreVersion: string | null = null;
  try { coreVersion = (JSON.parse(readFileSync(corePkg, "utf8")) as { version?: string }).version ?? null; } catch { /* not installed */ }

  let configName: string | null = null;
  try { configName = readdirSync(root).find((file) => /^astro\.config\.(m?[jt]s|cjs)$/.test(file)) ?? null; } catch { /* no root */ }
  const configWired = Boolean(configName && readFileSync(resolve(root, configName), "utf8").includes("@caretcms/core"));

  const isRepo = git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  const status = isRepo ? git(root, ["status", "--porcelain", "--", "src/content", "public/uploads"]) ?? "" : "";
  const env = readEnv(root);

  return {
    coreVersion,
    configName,
    configWired,
    drafts: readDrafts(root),
    git: isRepo,
    uncommitted: status.split("\n").map((line) => line.trimEnd()).filter(Boolean),
    commitsOnPublish: env.CARET_GIT_ON_PUBLISH === "true",
    ignoredUploads: isRepo && ignored(root, "public/uploads/x.png"),
    draftsNotIgnored: isRepo && !ignored(root, ".caret/drafts/x"),
    envNotIgnored: isRepo && existsSync(resolve(root, ".env")) && !ignored(root, ".env"),
    unusedUploads: findUnusedUploads(root),
    strictSchemaRisk: findStrictSchemaRisk(root),
    missingSecret: !env.CARET_SESSION_SECRET,
    placeholderPassword: env.CARET_EDIT_PASSWORD !== undefined && /^(|change-?me|changeme|password)$/i.test(env.CARET_EDIT_PASSWORD),
  };
}

function age(from: number, now: number): string {
  const hours = Math.max(0, Math.round((now - from) / 3_600_000));
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function plural(count: number, one: string, other: string): string {
  return `${count} ${count === 1 ? one : other}`;
}

export interface Report {
  lines: string[];
  /** Things that are broken or will break a deploy. */
  problems: number;
  /** Things worth a look. */
  warnings: number;
}

/** What the inspection means for the developer, most serious first within each section. */
export function report(found: Inspection, now: number, caretize = "npx @caretcms/caretize"): Report {
  const lines: string[] = [];
  let problems = 0, warnings = 0;
  const ok = (text: string) => lines.push(`✓ ${text}`);
  const warn = (text: string, ...detail: string[]) => { warnings++; lines.push(`⚠ ${text}`, ...detail.map((line) => `    ${line}`)); };
  const bad = (text: string, ...detail: string[]) => { problems++; lines.push(`✗ ${text}`, ...detail.map((line) => `    ${line}`)); };

  // Setup
  if (found.coreVersion) ok(`@caretcms/core ${found.coreVersion} is installed (upgrade notes: https://github.com/web-stacked/caretcms/blob/main/CHANGELOG.md)`);
  else bad("@caretcms/core isn't installed", "Run npm install, or set the project up with: " + `${caretize} init`);
  if (!found.configName) bad("No astro.config found: run this from the project's root folder");
  else if (found.configWired) ok(`${found.configName} uses CaretCMS`);
  else warn(`${found.configName} doesn't use CaretCMS`, `Wire it in with: ${caretize} init`);
  if (found.strictSchemaRisk) {
    bad("A .strict() content schema will reject the __caret_template__ key your content files carry, and the build fails",
      "Add it to that collection's schema:",
      "  __caret_template__: z.record(z.string(), z.string()).optional(),");
  }
  if (found.missingSecret) warn(".env has no CARET_SESSION_SECRET", "Fine in dev. Set one before the site is reachable by others.");
  if (found.placeholderPassword) warn(".env still has the placeholder CARET_EDIT_PASSWORD", "Set a real password before the site is reachable by others.");

  // Drafts
  if (!found.drafts.length) ok("No unpublished drafts");
  for (const set of found.drafts) {
    const old = now - set.newest > 24 * 3_600_000;
    const text = `Editor ${set.editor.slice(0, 8)} has ${plural(set.entries.length, "unpublished draft", "unpublished drafts")}, last saved ${age(set.newest, now)}: ${set.entries.join(", ")}`;
    if (old) {
      warn(text,
        "A signed-in editor sees their drafts in place of the published content, on the fields they edited.",
        "To publish or discard them, sign in with that browser. To drop them for everyone:",
        `  rm -rf .caret/drafts/${set.editor}`);
    } else lines.push(`• ${text}`);
  }

  // Git
  if (!found.git) warn("This folder isn't a Git repository", "Published content is written to your files; Git is how you review and undo it.");
  else {
    if (found.uncommitted.length) {
      warn(`${plural(found.uncommitted.length, "content file or upload isn't", "content files or uploads aren't")} committed to Git`,
        ...found.uncommitted.slice(0, 10), ...(found.uncommitted.length > 10 ? [`… and ${found.uncommitted.length - 10} more`] : []),
        found.commitsOnPublish
          ? "Publish asks before it commits a file with changes like these."
          : "A site deployed from Git doesn't have these yet. Commit them, or set CARET_GIT_ON_PUBLISH=true to commit on Publish.");
    } else ok("Content and uploads are committed");
    if (found.ignoredUploads) bad("public/uploads is ignored by Git", "Uploaded images would never reach a site deployed from Git. Remove it from .gitignore.");
    if (found.draftsNotIgnored) warn(".caret/drafts isn't ignored by Git", "Unpublished drafts could be committed. Add .caret/drafts/ to .gitignore.");
    if (found.envNotIgnored) bad(".env isn't ignored by Git", "It holds the editing password and session secret. Add .env to .gitignore.");
  }

  // Uploads
  if (found.unusedUploads.length) {
    warn(`${plural(found.unusedUploads.length, "uploaded image isn't", "uploaded images aren't")} used by any content, draft or template`,
      ...found.unusedUploads.slice(0, 10).map((name) => `public/uploads/${name}`),
      ...(found.unusedUploads.length > 10 ? [`… and ${found.unusedUploads.length - 10} more`] : []),
      "They ship with every build. Delete the ones you don't need.");
  }

  lines.push("", problems || warnings
    ? `${plural(problems, "problem", "problems")}, ${plural(warnings, "thing", "things")} to look at.`
    : "Everything looks right.");
  return { lines, problems, warnings };
}
