/**
 * Studio chrome theme tokens.
 *
 * Only one preset ships with core: `studio`, the neutral dark chrome
 * that matches the inline editor's "click to edit" blue. Distributable
 * site themes live in separate packages (e.g. @caretcms/theme-*),
 * not in this preset registry.
 *
 * The values below populate the --color-theme-* / --font-theme-* tokens
 * declared in static/cms/studio-tokens.css. The studio-* aliases inherit
 * automatically.
 */

export type ThemeTokens = Record<string, string>;

const STUDIO: ThemeTokens = {
  // Surface
  "--color-theme-bg-deep": "#0c0e12",
  "--color-theme-surface": "#14171c",
  "--color-theme-surface-elevated": "#1c2027",
  "--color-theme-surface-muted": "rgba(255, 255, 255, 0.03)",
  // Border
  "--color-theme-border-subtle": "rgba(255, 255, 255, 0.06)",
  "--color-theme-border": "rgba(255, 255, 255, 0.10)",
  // Accent — matches the inline editor's "editable" blue (#3b82f6)
  "--color-theme-accent": "#60a5fa",
  "--color-theme-accent-soft": "rgba(59, 130, 246, 0.12)",
  "--color-theme-accent-strong": "rgba(59, 130, 246, 0.24)",
  "--color-theme-on-accent": "#07111f",
  // Text
  "--color-theme-text": "rgba(255, 255, 255, 0.92)",
  "--color-theme-text-muted": "#b6bac3",
  "--color-theme-text-dim": "#9298a3",
  // State
  "--color-theme-success": "#22c55e",
  "--color-theme-danger": "#ef4444",
  "--color-theme-info": "#3b82f6",
  "--color-theme-warning": "#eab308",
  // Typography — one family, system-friendly, no editorial drama
  "--font-theme-body": "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  "--font-theme-heading": "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

const PRESET_TOKENS: Record<string, ThemeTokens> = {
  studio: STUDIO,
};

export const DEFAULT_PRESET_ID = "studio";

export function getPresetTokens(themeId: string): ThemeTokens {
  return PRESET_TOKENS[themeId] ?? PRESET_TOKENS[DEFAULT_PRESET_ID];
}
