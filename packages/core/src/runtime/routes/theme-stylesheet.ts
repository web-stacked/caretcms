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
// A valid CSS custom-property name. Token overrides come from author config, so
// we validate both sides before interpolating into the `:root { prop: value; }`
// slot — a stray `}` in a value, or markup in a key, would otherwise break out of
// the rule block (or the CSS response entirely).
const CSS_CUSTOM_PROP_RE = /^--[A-Za-z0-9-]+$/;

/** Reject values that can't sit inside a `prop: value;` slot without escaping it. */
function isSafeTokenValue(value: string): boolean {
  return !/[{}<>;]/.test(value);
}

function buildCss(tokens: ThemeTokens): string {
  const lines = Object.entries(tokens)
    .filter(([prop, value]) => CSS_CUSTOM_PROP_RE.test(prop) && isSafeTokenValue(value))
    .map(([prop, value]) => `  ${prop}: ${value.trim()};`)
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
