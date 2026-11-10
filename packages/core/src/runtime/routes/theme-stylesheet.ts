export const prerender = false;

import type { APIContext } from "astro";
import { getRuntimeConfig } from "../config.js";
import {
  DEFAULT_PRESET_ID,
  getPresetModes,
  type ThemeTokens,
} from "../themes/preset-tokens.js";

/**
 * Emits the active theme as a CSS file consumed by the studio shell.
 *
 * Resolution order:
 *   1. The preset's dark tokens, then its light tokens when the system prefers
 *      light or the editor chose light (`<html data-theme="light">`).
 *   2. Per-token overrides from `caret({ theme: { tokens: {...} } })`, which
 *      apply in both modes.
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

function declarations(tokens: ThemeTokens, indent: string): string {
  return Object.entries(tokens)
    .filter(([prop, value]) => CSS_CUSTOM_PROP_RE.test(prop) && isSafeTokenValue(value))
    .map(([prop, value]) => `${indent}${prop}: ${value.trim()};`)
    .join("\n");
}

function buildCss(dark: ThemeTokens, light: ThemeTokens, overrides: ThemeTokens): string {
  let css = `:root {\n  color-scheme: dark;\n${declarations(dark, "  ")}\n}\n`;
  css += `@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {\n    color-scheme: light;\n${declarations(light, "    ")}\n  }\n}\n`;
  css += `:root[data-theme="light"] {\n  color-scheme: light;\n${declarations(light, "  ")}\n}\n`;
  const custom = declarations(overrides, "  ");
  // Same specificity as the light rules and emitted last, so overrides win in both modes.
  if (custom) css += `:root:not([data-theme="none"]) {\n${custom}\n}\n`;
  return css;
}

export async function GET(_context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const modes = getPresetModes(runtime.theme.presetId ?? DEFAULT_PRESET_ID);

  return new Response(buildCss(modes.dark, modes.light, runtime.theme.tokenOverrides), {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
