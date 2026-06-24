export const prerender = false;

import type { APIContext } from "astro";
import { getRuntimeConfig } from "../config.js";
import {
  DEFAULT_PRESET_ID,
  getPresetTokens,
  type ThemeTokens,
} from "../themes/preset-tokens.js";

/**
 * Emits the active theme as a CSS file consumed by the studio shell.
 *
 * Resolution order:
 *   1. Built-in preset tokens for the configured theme id (or default).
 *   2. Per-token overrides from `caret({ theme: { tokens: {...} } })`.
 *
 * Brand customizations (logo URL, etc.) are NOT emitted here — they live
 * in the integration's `clientConfig` and are read by the studio HTML.
 */
function buildCss(tokens: ThemeTokens): string {
  const lines = Object.entries(tokens)
    .map(([prop, value]) => `  ${prop}: ${value};`)
    .join("\n");

  return `:root {\n${lines}\n}\n`;
}

export async function GET(_context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const presetId = runtime.theme.presetId ?? DEFAULT_PRESET_ID;
  const baseTokens = getPresetTokens(presetId);
  const merged: ThemeTokens = { ...baseTokens, ...runtime.theme.tokenOverrides };

  return new Response(buildCss(merged), {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
