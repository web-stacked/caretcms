// Bundled-data discovery: Vite transforms the syntactic glob call at build time
// and inlines the result. The try/catch covers the plain-Node import path used by
// astro.config.mjs loaders, where `import.meta.glob` is not defined.
type GlobMap = Record<string, Record<string, unknown>>;
let _bundled: GlobMap | null = null;
export function getDataModules(): GlobMap {
  if (_bundled) return _bundled;
  try {
    _bundled = import.meta.glob<Record<string, unknown>>(
      "/.caret/data/**/*.json",
      { eager: true, import: "default" },
    );
  } catch {
    _bundled = {};
  }
  return _bundled;
}

