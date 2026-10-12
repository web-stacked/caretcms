/**
 * Studio chrome theme tokens.
 *
 * Only one preset ships with core: `studio`, a neutral chrome with the inline
 * editor's "click to edit" blue. It has a dark and a light variant; the Studio
 * follows the operating system unless the editor picks one. Distributable site
 * themes live in separate packages (e.g. @caretcms/theme-*), not here.
 *
 * The values below populate the --color-theme-* / --font-theme-* tokens
 * declared in static/cms/studio-tokens.css. The studio-* aliases inherit
 * automatically.
 */

export type ThemeTokens = Record<string, string>;
export type ThemeModes = { dark: ThemeTokens; light: ThemeTokens };

const SHARED: ThemeTokens = {
  // Typography — one family, system-friendly, no editorial drama
  "--font-theme-body": "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  "--font-theme-heading": "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

const STUDIO_DARK: ThemeTokens = {
  ...SHARED,
  // Surface
  "--color-theme-bg-deep": "#0b0d11",
  "--color-theme-surface": "#12151b",
  "--color-theme-surface-elevated": "#1a1e26",
  "--color-theme-surface-muted": "rgba(255, 255, 255, 0.03)",
  "--color-theme-sidebar": "#0e1015",
  "--color-theme-input": "rgba(255, 255, 255, 0.04)",
  "--color-theme-overlay": "rgba(255, 255, 255, 0.06)",
  "--color-theme-scrim": "rgba(3, 5, 9, 0.62)",
  "--shadow-theme-raised": "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.32)",
  // Border
  "--color-theme-border-subtle": "rgba(255, 255, 255, 0.07)",
  "--color-theme-border": "rgba(255, 255, 255, 0.12)",
  // Accent — matches the inline editor's "editable" blue (#3b82f6)
  "--color-theme-accent": "#60a5fa",
  "--color-theme-accent-soft": "rgba(59, 130, 246, 0.14)",
  "--color-theme-accent-strong": "rgba(59, 130, 246, 0.28)",
  "--color-theme-on-accent": "#07111f",
  // Text
  "--color-theme-text": "rgba(255, 255, 255, 0.92)",
  "--color-theme-text-muted": "#b6bac3",
  "--color-theme-text-dim": "#9298a3",
  // State
  "--color-theme-success": "#22c55e",
  "--color-theme-danger": "#f87171",
  "--color-theme-info": "#3b82f6",
  "--color-theme-warning": "#eab308",
  "--color-theme-success-soft": "rgba(34, 197, 94, 0.14)",
  "--color-theme-danger-soft": "rgba(248, 113, 113, 0.14)",
  // Filled destructive buttons: white text keeps 4.5:1 in both modes.
  "--color-theme-danger-strong": "#b91c1c",
  "--color-theme-warning-soft": "rgba(234, 179, 8, 0.14)",
};

const STUDIO_LIGHT: ThemeTokens = {
  ...SHARED,
  // Surface
  "--color-theme-bg-deep": "#f5f6f8",
  "--color-theme-surface": "#ffffff",
  "--color-theme-surface-elevated": "#f0f2f5",
  "--color-theme-surface-muted": "rgba(15, 23, 42, 0.03)",
  "--color-theme-sidebar": "#fbfbfc",
  "--color-theme-input": "#ffffff",
  "--color-theme-overlay": "rgba(15, 23, 42, 0.05)",
  "--color-theme-scrim": "rgba(15, 23, 42, 0.38)",
  "--shadow-theme-raised": "0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.08)",
  // Border
  "--color-theme-border-subtle": "rgba(15, 23, 42, 0.08)",
  "--color-theme-border": "rgba(15, 23, 42, 0.15)",
  // Accent — deep enough for white button text and accent links to clear 4.5:1
  "--color-theme-accent": "#1d4ed8",
  "--color-theme-accent-soft": "rgba(29, 78, 216, 0.09)",
  "--color-theme-accent-strong": "rgba(29, 78, 216, 0.22)",
  "--color-theme-on-accent": "#ffffff",
  // Text
  "--color-theme-text": "#0f172a",
  // Dim text keeps 4.5:1 contrast on the page background, not just on cards.
  "--color-theme-text-muted": "#3d4757",
  "--color-theme-text-dim": "#556070",
  // State
  "--color-theme-success": "#15803d",
  "--color-theme-danger": "#dc2626",
  "--color-theme-info": "#2563eb",
  "--color-theme-warning": "#a16207",
  "--color-theme-success-soft": "rgba(22, 163, 74, 0.1)",
  "--color-theme-danger-soft": "rgba(220, 38, 38, 0.08)",
  "--color-theme-danger-strong": "#dc2626",
  "--color-theme-warning-soft": "rgba(202, 138, 4, 0.12)",
};

const PRESET_TOKENS: Record<string, ThemeModes> = {
  studio: { dark: STUDIO_DARK, light: STUDIO_LIGHT },
};

export const DEFAULT_PRESET_ID = "studio";

export function getPresetModes(themeId: string): ThemeModes {
  return PRESET_TOKENS[themeId] ?? PRESET_TOKENS[DEFAULT_PRESET_ID];
}
