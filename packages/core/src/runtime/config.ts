import type { CaretMode } from "../types.js";

declare const __ASTRO_CARET_MOUNT_PATH__: string | undefined;
declare const __ASTRO_CARET_API_BASE_PATH__: string | undefined;
declare const __ASTRO_CARET_MODE__: string | undefined;
declare const __ASTRO_CARET_THEME_CONFIG__: string | undefined;
declare const __ASTRO_CARET_BRAND_CONFIG__: string | undefined;

export type CaretBrandConfig = {
  name: string;
  logo: string | null;
  faviconUrl: string | null;
};

export type CaretThemeConfig = {
  presetId: string | null;
  tokenOverrides: Record<string, string>;
};

export type CaretRuntimeConfig = {
  mountPath: string;
  apiBasePath: string;
  mode: CaretMode;
  theme: CaretThemeConfig;
  brand: CaretBrandConfig;
};

export function normalizePath(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")) {
    return withLeadingSlash.slice(0, -1);
  }
  return withLeadingSlash;
}

function safeParse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const DEFAULT_BRAND: CaretBrandConfig = {
  name: "Content Studio",
  logo: null,
  faviconUrl: null,
};

const DEFAULT_THEME: CaretThemeConfig = {
  presetId: null,
  tokenOverrides: {},
};

export function getRuntimeConfig(): CaretRuntimeConfig {
  const mountPath = normalizePath(__ASTRO_CARET_MOUNT_PATH__, "/admin");
  const apiBasePath = normalizePath(__ASTRO_CARET_API_BASE_PATH__, "/api/cms");
  const mode = (__ASTRO_CARET_MODE__ ?? "embedded") as CaretMode;
  const theme = safeParse<CaretThemeConfig>(
    __ASTRO_CARET_THEME_CONFIG__,
    DEFAULT_THEME,
  );
  const brand = safeParse<CaretBrandConfig>(
    __ASTRO_CARET_BRAND_CONFIG__,
    DEFAULT_BRAND,
  );

  return { mountPath, apiBasePath, mode, theme, brand };
}
