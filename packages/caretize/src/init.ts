/**
 * Pure helpers for `caretize init` — the one command that wires CaretCMS into an
 * Astro project so tagging actually makes content editable (the gap preflight
 * only *warns* about today). Kept process-free and side-effect-free so the
 * load-bearing logic — editing an existing astro.config, scaffolding .env — is
 * unit-testable; cli.ts owns the readline I/O, the npm install, and disk writes.
 *
 * Config editing mirrors caretize's write contract: every edit is a PURE
 * INSERTION of the original bytes (verified by a subsequence check), so an edit
 * can add to a config but never delete or reorder what's there. When the config
 * shape isn't one we can touch confidently, planConfigWiring returns ok:false
 * and the caller falls back to printing a snippet to paste — never a silent
 * corruption.
 */

/** True when every character of `needle` appears in `haystack` in order. The
 *  proof that an edit only inserted: no original character was dropped/moved. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

const CARET_IMPORT = `import caret from '@caretcms/core';`;
const NODE_IMPORT = `import node from '@astrojs/node';`;

export type InitMode = "static" | "server";

function caretCall(): string {
  return "caret()";
}

/** A complete, minimal embedded-mode config — written verbatim when a project
 *  has no astro.config at all, and shown as the paste-me snippet when an
 *  existing config is too complex to edit safely. */
export function freshConfig(mode: InitMode = "static"): string {
  if (mode === "server") {
    return (
      `import { defineConfig } from 'astro/config';\n` +
      `import node from '@astrojs/node';\n` +
      `import caret from '@caretcms/core';\n` +
      `\n` +
      `export default defineConfig({\n` +
      `  output: 'server',\n` +
      `  adapter: node({ mode: 'standalone' }),\n` +
      `  integrations: [caret()],\n` +
      `});\n`
    );
  }

  return (
    `import { defineConfig } from 'astro/config';\n` +
    `import caret from '@caretcms/core';\n` +
    `\n` +
    `export default defineConfig({\n` +
    `  integrations: [caret()],\n` +
    `});\n`
  );
}

/** What's missing from the config and therefore needs wiring in. Computed by the
 *  caller from preflight + a scan for an existing `adapter:` key. */
export interface WiringNeeds {
  /** caret() not referenced — add the import + an integrations entry. */
  caret: boolean;
  /** No `adapter:` configured and server mode was selected — add @astrojs/node. */
  adapter: boolean;
  /** output isn't "server" and server mode was selected — add output: 'server'. */
  output: boolean;
  /**
   * Static sites use caret() with delivery: "auto" by default. Kept as a
   * planning flag so older callers/tests can ask for static delivery without
   * forcing an explicit config-file edit.
   */
  staticDelivery: boolean;
}

export interface WiringResult {
  /** The edited config (=== source when nothing could be inserted). */
  output: string;
  /** Human-readable list of what was inserted, for the closing summary. */
  inserted: string[];
  /** Things we deliberately did NOT auto-apply (would require a replacement,
   *  not an insertion) — surfaced so the user fixes them by hand. */
  manual: string[];
  /** false → the config shape wasn't recognized; caller should fall back to the
   *  paste-me snippet rather than write a half-edited file. */
  ok: boolean;
}

/** Index of the `{` that opens the config object — defineConfig({…}) preferred,
 *  bare `export default {…}` accepted. null when neither shape is present. */
export function findConfigObjectBrace(source: string): number | null {
  const m = source.match(/defineConfig\s*\(\s*\{/);
  if (m && m.index !== undefined) return m.index + m[0].length - 1;
  const m2 = source.match(/export\s+default\s*\{/);
  if (m2 && m2.index !== undefined) return m2.index + m2[0].length - 1;
  return null;
}

/** Offset just past the last top-level `import …` line (0 when there are none),
 *  so new imports land after the existing import block. */
function lastImportEnd(source: string): number {
  const re = /^import[^\n]*\n/gm;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(source); m; m = re.exec(source)) last = m;
  return last ? last.index + last[0].length : 0;
}

/**
 * Plan the edits that wire caret() / the adapter / output into an EXISTING
 * config. Returns the edited text plus what was inserted vs. what needs manual
 * attention. All edits are pure insertions; the result is subsequence-verified
 * against the source, and any failure (unrecognized shape, verification miss)
 * yields ok:false so the caller prints a snippet instead.
 */
export function planConfigWiring(source: string, needs: WiringNeeds): WiringResult {
  const inserted: string[] = [];
  const manual: string[] = [];

  const braceIdx = findConfigObjectBrace(source);
  if (braceIdx === null) return { output: source, inserted, manual, ok: false };

  const edits: Array<{ index: number; text: string }> = [];

  // Imports — only those not already present, inserted after the import block.
  const importsToAdd: string[] = [];
  if (needs.caret && !/from\s+['"]@caretcms\/core['"]/.test(source)) importsToAdd.push(CARET_IMPORT);
  if (needs.adapter && !/from\s+['"]@astrojs\/node['"]/.test(source)) importsToAdd.push(NODE_IMPORT);
  if (importsToAdd.length) {
    edits.push({ index: lastImportEnd(source), text: importsToAdd.join("\n") + "\n" });
    inserted.push(...importsToAdd);
  }

  // New object properties — combined into one block at the config brace so they
  // land in a stable, readable order regardless of insertion bookkeeping.
  const newProps: string[] = [];

  if (needs.output) {
    if (/\boutput\s*:/.test(source)) {
      // Changing an existing value would be a replacement, not an insertion —
      // outside the safety contract, so hand it back to the user.
      manual.push(`set output to 'server' (config already declares an output)`);
    } else {
      newProps.push(`output: 'server',`);
      inserted.push(`output: 'server'`);
    }
  }

  if (needs.adapter) {
    newProps.push(`adapter: node({ mode: 'standalone' }),`);
    inserted.push(`adapter: node({ mode: 'standalone' })`);
  }

  if (needs.caret) {
    const intMatch = source.match(/integrations\s*:\s*\[/);
    const call = caretCall();
    if (intMatch && intMatch.index !== undefined) {
      if (/\bcaret\s*\(/.test(source)) {
        // Defensive: caller gates on !caretWired, but never double-insert.
      } else {
        const at = intMatch.index + intMatch[0].length;
        // No trailing comma when the array is empty (`[]`) — only when there's
        // an existing entry to precede.
        const empty = source.slice(at).trimStart().startsWith("]");
        edits.push({ index: at, text: empty ? call : `${call}, ` });
        inserted.push(empty ? `integrations: [${call}]` : `integrations: [${call}, …]`);
      }
    } else {
      newProps.push(`integrations: [${call}],`);
      inserted.push(`integrations: [${call}]`);
    }
  } else if (needs.staticDelivery) {
    if (
      /delivery\s*:\s*(?:(["'])server\1|\{[^}]*mode\s*:\s*(["'])server\2)/s.test(
        source,
      )
    ) {
      manual.push(`remove delivery: "server" or change it to delivery: "auto" for static output`);
    } else if (/delivery\s*:/.test(source)) {
      manual.push(`verify delivery is "auto" or "static" for static output`);
    }
  }

  if (newProps.length) {
    edits.push({ index: braceIdx + 1, text: `\n  ` + newProps.join(`\n  `) });
  }

  // Apply highest-offset-first so earlier edits don't shift later indices.
  edits.sort((a, b) => b.index - a.index);
  let output = source;
  for (const e of edits) output = output.slice(0, e.index) + e.text + output.slice(e.index);

  // Safety gate: prove it's a pure insertion. If somehow it isn't, refuse.
  if (output !== source && !isSubsequence(source, output)) {
    return { output: source, inserted: [], manual, ok: false };
  }

  return { output, inserted, manual, ok: true };
}

/**
 * Plan additions to a project's .env. Generates nothing itself — the caller
 * passes a freshly-generated `secret` (mirrors backup.ts injecting its
 * timestamp), keeping this deterministic and testable. Existing keys (commented
 * or not) are never touched, so re-running init is idempotent.
 *
 * CARET_SESSION_SECRET is a machine secret → generated outright. The edit
 * password is left as a COMMENTED placeholder so dev keeps printing a temp
 * password (an empty value would suppress that), while still reminding the user
 * to set one before deploying.
 */
export function renderEnvAdditions(
  existing: string,
  secret: string,
): { append: string; added: string[] } {
  const has = (k: string): boolean => new RegExp(`^\\s*#?\\s*${k}\\s*=`, "m").test(existing);
  const lines: string[] = [];
  const added: string[] = [];

  if (!has("CARET_SESSION_SECRET")) {
    lines.push(`CARET_SESSION_SECRET=${secret}`);
    added.push("CARET_SESSION_SECRET (generated)");
  }
  if (!has("CARET_EDIT_PASSWORD")) {
    lines.push(`# Set before deploying — until then dev prints a temp password:`);
    lines.push(`# CARET_EDIT_PASSWORD=choose-a-strong-password`);
    added.push("CARET_EDIT_PASSWORD (placeholder)");
  }

  if (lines.length === 0) return { append: "", added };

  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  const header = existing.trim() ? "\n# CaretCMS\n" : "# CaretCMS\n";
  return { append: sep + header + lines.join("\n") + "\n", added };
}
