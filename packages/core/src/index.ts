import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AstroIntegration } from "astro";
import { COLLECTION_NAME_RE } from "./runtime/storage/id-contracts.js";
import type {
  CaretMode,
  CaretStorageProvider,
  CaretUploadProvider,
  RuntimeProviderReference,
} from "./types.js";

// --- Public type re-exports ---
export type {
  StorageAdapter,
  UploadHandler,
  UploadContext,
  EntryData,
  HistoryEntry,
  CollectionMetadata,
  CollectionSchema,
  CaretMode,
  CaretStorageProvider,
  CaretUploadProvider,
  RuntimeProviderReference,
} from "./types.js";
export { FilesystemAdapter } from "./runtime/storage/filesystem-adapter.js";
export { MarkdownAdapter } from "./runtime/storage/markdown-adapter.js";
export { InMemoryAdapter } from "./runtime/storage/in-memory-adapter.js";
export { FilesystemUploadHandler } from "./runtime/storage/filesystem-upload-handler.js";
export { bindEntry } from "./runtime/bind.js";
export { caretLoader, CaretLoaderError } from "./loader.js";
export type { CaretLiveLoader } from "./loader.js";
export { editable } from "./editable.js";

const VIRTUAL_PROVIDER_MODULE_ID = "virtual:caretcms/providers";
const RESOLVED_VIRTUAL_PROVIDER_MODULE_ID = `\0${VIRTUAL_PROVIDER_MODULE_ID}`;
const VIRTUAL_SCHEMAS_MODULE_ID = "virtual:caretcms/schemas";
const RESOLVED_VIRTUAL_SCHEMAS_MODULE_ID = `\0${VIRTUAL_SCHEMAS_MODULE_ID}`;
const FILESYSTEM_STORAGE_ENTRYPOINT = "@caretcms/core/providers/storage/filesystem";
const MARKDOWN_STORAGE_ENTRYPOINT = "@caretcms/core/providers/storage/markdown";
const LOCAL_UPLOADS_ENTRYPOINT = "@caretcms/core/providers/uploads/local";

type ProviderDefinitionOptions = {
  entrypoint: string;
  exportName?: string;
  options?: Record<string, unknown> | null;
};

export interface CaretCloudOptions extends Record<string, unknown> {
  endpoint: string;
  projectId: string;
  contentPath?: string;
  publicToken?: string;
  environment?: string;
}

type JsonSchemaDefinition = Record<string, unknown>;

export type CaretThemeOption =
  | string
  | {
      preset?: string;
      tokens?: Record<string, string>;
    };

export type CaretBrandOption = {
  name?: string;
  logo?: string;
  faviconUrl?: string;
};

type BaseCaretOptions = {
  mountPath?: string;
  apiBasePath?: string;
  enableAdmin?: boolean;
  enableInlineEditor?: boolean;
  /**
   * The page the editor lands on after a successful login. Must be an
   * absolute, same-origin path (starts with a single `/`). An explicit
   * `?redirect=` on the login URL always takes precedence. Defaults to `"/"`
   * so the user lands on a live page with the inline editor active rather
   * than the empty Studio shell.
   *
   * @example caret({ editorHome: "/blog" })
   */
  editorHome?: string;
  /**
   * Optional collection schemas as JSON Schema objects. When provided, Studio
   * uses these for field labels, types, and validation instead of inferring
   * schema from the first entry.
   *
   * Keys are collection names, values are JSON Schema objects (e.g. produced
   * by z.toJSONSchema() from a Zod schema).
   */
  schemas?: Record<string, JsonSchemaDefinition>;
  /**
   * Per-tag class allowlist for rich-text (`data-caret-rich`) fields. By default
   * the rich-text sanitizer strips every `class` (keeping only semantic inline
   * tags), so design-system classes inside editable content are lost on save.
   * Use this to bless specific classes so they round-trip unchanged.
   *
   * Keys are tag names, values are allowed class names. A pattern ending in `*`
   * is a prefix match (`"text-*"` allows `text-primary`); a lone `"*"` allows any
   * class on that tag. Example: `{ strong: ["text-theme-text-primary"], a: ["cta"] }`.
   *
   * Prefer styling semantic tags via CSS over allowlisting classes; reach for
   * this only when a specific class genuinely must live inside editable content.
   */
  allowedClasses?: Record<string, string[]>;
  /**
   * Studio chrome theme. Defaults to 'studio' — a neutral dark chrome that
   * matches the inline editor's "click to edit" blue. Currently the only
   * built-in preset; pass `{ tokens: { ... } }` to override individual
   * `--color-theme-*` / `--font-theme-*` values without forking the preset.
   */
  theme?: CaretThemeOption;
  /**
   * Branding shown in the studio chrome (header brand mark, login title,
   * favicon).
   */
  brand?: CaretBrandOption;
};

export type CaretOptions =
  | (BaseCaretOptions & {
      mode?: "embedded";
      storage?: CaretStorageProvider;
      uploads?: CaretUploadProvider;
      cloud?: never;
    })
  | (BaseCaretOptions & {
      mode: "cloud";
      cloud: CaretCloudOptions;
      storage?: never;
      uploads?: never;
    });

interface ResolvedThemeConfig {
  presetId: string | null;
  tokenOverrides: Record<string, string>;
}

interface ResolvedBrandConfig {
  name: string;
  logo: string | null;
  faviconUrl: string | null;
}

interface ResolvedCaretOptions {
  mountPath: string;
  apiBasePath: string;
  mode: CaretMode;
  storage: CaretStorageProvider | null;
  uploads: CaretUploadProvider | null;
  enableAdmin: boolean;
  enableInlineEditor: boolean;
  editorHome: string;
  cloud: CaretCloudOptions | null;
  schemas: Record<string, JsonSchemaDefinition>;
  allowedClasses: Record<string, string[]>;
  theme: ResolvedThemeConfig;
  brand: ResolvedBrandConfig;
}

export function defineStorageProvider(
  options: ProviderDefinitionOptions,
): CaretStorageProvider {
  return {
    kind: "storage",
    entrypoint: options.entrypoint,
    exportName: options.exportName ?? "default",
    options: options.options ?? null,
  };
}

export function defineUploadProvider(
  options: ProviderDefinitionOptions,
): CaretUploadProvider {
  return {
    kind: "uploads",
    entrypoint: options.entrypoint,
    exportName: options.exportName ?? "default",
    options: options.options ?? null,
  };
}

export function filesystemStorage(options?: {
  dataRoot?: string;
  metaRoot?: string;
}): CaretStorageProvider {
  return defineStorageProvider({
    entrypoint: FILESYSTEM_STORAGE_ENTRYPOINT,
    exportName: "filesystemStorageProvider",
    options,
  });
}

export function markdownStorage(options?: {
  contentRoot?: string;
  metaRoot?: string;
}): CaretStorageProvider {
  return defineStorageProvider({
    entrypoint: MARKDOWN_STORAGE_ENTRYPOINT,
    exportName: "markdownStorageProvider",
    options,
  });
}

export function localUploads(options?: {
  uploadsDir?: string;
}): CaretUploadProvider {
  return defineUploadProvider({
    entrypoint: LOCAL_UPLOADS_ENTRYPOINT,
    exportName: "localUploadsProvider",
    options,
  });
}

import { normalizePath as normalizeMountPath } from "./runtime/config.js";

function normalizeMode(input: CaretMode | undefined): CaretMode {
  return input ?? "embedded";
}

function normalizeCloudOptions(input: CaretCloudOptions): CaretCloudOptions {
  const endpoint = input.endpoint.trim().replace(/\/$/, "");
  const projectId = input.projectId.trim();

  if (!endpoint) {
    throw new Error("[caretcms] Cloud mode requires cloud.endpoint.");
  }
  if (!projectId) {
    throw new Error("[caretcms] Cloud mode requires cloud.projectId.");
  }

  return {
    endpoint,
    projectId,
    contentPath: input.contentPath?.trim() || "/content",
    publicToken: input.publicToken?.trim() || undefined,
    environment: input.environment?.trim() || undefined,
  };
}

function isProviderReference<TKind extends "storage" | "uploads">(
  value: unknown,
  kind: TKind,
): value is RuntimeProviderReference<TKind> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === kind &&
    typeof candidate.entrypoint === "string" &&
    candidate.entrypoint.trim().length > 0
  );
}

function defaultProviders(mode: CaretMode): {
  storage: CaretStorageProvider | null;
  uploads: CaretUploadProvider | null;
} {
  if (mode === "cloud") {
    return {
      storage: null,
      uploads: null,
    };
  }

  return {
    storage: filesystemStorage(),
    uploads: localUploads(),
  };
}

function resolveTheme(input: CaretThemeOption | undefined): ResolvedThemeConfig {
  if (!input) return { presetId: null, tokenOverrides: {} };
  if (typeof input === "string") {
    return { presetId: input, tokenOverrides: {} };
  }
  return {
    presetId: input.preset ?? null,
    tokenOverrides: input.tokens ?? {},
  };
}

function resolveBrand(input: CaretBrandOption | undefined): ResolvedBrandConfig {
  return {
    name: input?.name?.trim() || "Content Studio",
    logo: input?.logo?.trim() || null,
    faviconUrl: input?.faviconUrl?.trim() || null,
  };
}

/** Every key resolveCaretOptions reads. Anything else in the options object is
 *  a typo (`mountpath`) silently falling back to a default — name it instead. */
const KNOWN_OPTION_KEYS = new Set([
  "mode", "cloud", "storage", "uploads", "mountPath", "apiBasePath",
  "enableAdmin", "enableInlineEditor", "editorHome", "schemas",
  "allowedClasses", "theme", "brand",
]);

/** Unknown option keys, each with its closest known key when one is plausible. */
function unknownOptionWarnings(options: CaretOptions): string[] {
  return Object.keys(options)
    .filter((key) => !KNOWN_OPTION_KEYS.has(key))
    .map((key) => {
      const lower = key.toLowerCase();
      const near = [...KNOWN_OPTION_KEYS].find((k) => k.toLowerCase() === lower);
      return near ? `"${key}" (did you mean "${near}"?)` : `"${key}"`;
    });
}

function resolveCaretOptions(options: CaretOptions): ResolvedCaretOptions {
  const mode = normalizeMode(options.mode);
  const defaults = defaultProviders(mode);
  const cloud =
    mode === "cloud"
      ? normalizeCloudOptions((options as Extract<CaretOptions, { mode: "cloud" }>).cloud)
      : null;

  const editorHome = normalizeMountPath(options.editorHome, "/");
  if (editorHome.startsWith("//")) {
    throw new Error(
      `[caretcms] editorHome must be a same-origin absolute path (got ${JSON.stringify(
        options.editorHome,
      )}).`,
    );
  }

  return {
    mountPath: normalizeMountPath(options.mountPath, "/admin"),
    apiBasePath: normalizeMountPath(options.apiBasePath, "/api/cms"),
    mode,
    storage: isProviderReference((options as { storage?: unknown }).storage, "storage")
      ? (options as { storage: CaretStorageProvider }).storage
      : defaults.storage,
    uploads: isProviderReference((options as { uploads?: unknown }).uploads, "uploads")
      ? (options as { uploads: CaretUploadProvider }).uploads
      : defaults.uploads,
    enableAdmin: options.enableAdmin ?? mode !== "cloud",
    enableInlineEditor: options.enableInlineEditor ?? mode !== "cloud",
    editorHome,
    cloud,
    schemas: options.schemas ?? {},
    allowedClasses: options.allowedClasses ?? {},
    theme: resolveTheme(options.theme),
    brand: resolveBrand(options.brand),
  };
}

function buildProviderLoader(
  functionName: string,
  reference: RuntimeProviderReference | null,
): string {
  if (!reference) {
    return `export async function ${functionName}(){return null;}`;
  }

  const importName = `__caret_${functionName}`;

  return [
    `import * as ${importName} from ${JSON.stringify(reference.entrypoint)};`,
    `export async function ${functionName}(){`,
    `  const resolvedExport = ${importName}[${JSON.stringify(reference.exportName ?? "default")}] ?? ${importName}.default;`,
    "  if (resolvedExport == null) {",
    `    throw new Error(${JSON.stringify(
      `[caretcms] Could not resolve provider export "${reference.exportName ?? "default"}" from ${reference.entrypoint}.`,
    )});`,
    "  }",
    "  return typeof resolvedExport === 'function'",
    `    ? await resolvedExport(${JSON.stringify(reference.options ?? null)})`,
    "    : resolvedExport;",
    "}",
  ].join("\n");
}

function createRuntimeProvidersPlugin(resolved: ResolvedCaretOptions) {
  const source = [
    buildProviderLoader("loadConfiguredStorage", resolved.storage),
    buildProviderLoader("loadConfiguredUploadHandler", resolved.uploads),
    `export const allowedClasses = ${JSON.stringify(resolved.allowedClasses)};`,
    // Surfaced for the middleware's authenticated empty-state affordance: it
    // needs to know the inline editor is enabled and which paths are CMS-owned
    // (so the hint never shows inside the Studio / on API + asset routes).
    `export const enableInlineEditor = ${JSON.stringify(resolved.enableInlineEditor)};`,
    `export const mountPath = ${JSON.stringify(resolved.mountPath)};`,
    `export const apiBasePath = ${JSON.stringify(resolved.apiBasePath)};`,
  ].join("\n\n");

  return {
    name: "caretcms:runtime-providers",
    resolveId(id: string) {
      if (id === VIRTUAL_PROVIDER_MODULE_ID) {
        return RESOLVED_VIRTUAL_PROVIDER_MODULE_ID;
      }
      return null;
    },
    load(id: string) {
      if (id === RESOLVED_VIRTUAL_PROVIDER_MODULE_ID) {
        return source;
      }
      return null;
    },
  };
}

function createSchemasPlugin(schemas: Record<string, JsonSchemaDefinition>) {
  const hasSchemas = Object.keys(schemas).length > 0;

  const source = hasSchemas
    ? [
        `import { registerCollectionSchema } from "@caretcms/core/schema-registry";`,
        `import { buildTemplate } from "@caretcms/core/schema-utils";`,
        `const schemas = ${JSON.stringify(schemas)};`,
        `for (const [collection, schema] of Object.entries(schemas)) {`,
        `  registerCollectionSchema(collection, schema, buildTemplate(schema));`,
        `}`,
        `export const registered = true;`,
      ].join("\n")
    : `export const registered = false;`;

  return {
    name: "caretcms:schemas",
    resolveId(id: string) {
      if (id === VIRTUAL_SCHEMAS_MODULE_ID) {
        return RESOLVED_VIRTUAL_SCHEMAS_MODULE_ID;
      }
      return null;
    },
    load(id: string) {
      if (id === RESOLVED_VIRTUAL_SCHEMAS_MODULE_ID) {
        return source;
      }
      return null;
    },
  };
}

function describeProvider(reference: RuntimeProviderReference | null): string {
  if (!reference) return "none";
  return `${reference.entrypoint}#${reference.exportName ?? "default"}`;
}

function buildCloudBootstrapScript(
  clientConfig: Record<string, unknown>,
  cloud: CaretCloudOptions,
): string {
  return [
    `window.__CARET__ = ${JSON.stringify(clientConfig)};`,
    `import { bootstrapCloudCms, hasCloudCmsSession, redirectToCloudCmsLogin } from "@caretcms/core/browser-runtime";`,
    `const __caretCloudConfig = ${JSON.stringify(cloud)};`,
    `bootstrapCloudCms(__caretCloudConfig).then(async () => {`,
    `  const url = new URL(window.location.href);`,
    `  const wantsEditor = url.searchParams.get("cms") === "1";`,
    `  if (hasCloudCmsSession(__caretCloudConfig)) {`,
    `    await import("@caretcms/core/editor-runtime");`,
    `    return;`,
    `  }`,
    `  if (wantsEditor) {`,
    `    redirectToCloudCmsLogin(__caretCloudConfig, window.location.href);`,
    `  }`,
    `}).catch((error) => {`,
    `  console.warn("[caretcms] Cloud runtime bootstrap failed.", error);`,
    "});",
  ].join("\n");
}

/**
 * Zero-config storage detection (Zod-free): does `<root>/src/content` hold any
 * Astro content-collection directories? Mirrors `listCollectionDirs` — a child
 * dir whose name passes the collection-id contract — so what we detect here is
 * exactly what `MarkdownAdapter.discoverCollections()` will later surface in the
 * Studio. A plain readdir, no `astro:content` import and no config eval, keeping
 * core's zero-runtime-dep / Zod-agnostic boundary intact.
 *
 * `content.config.ts` is a file, not a dir, so it's naturally excluded. Returns
 * the collection names (for the log line) or `[]` when src/content is absent.
 */
function detectContentCollections(rootDir: string): string[] {
  const contentRoot = join(rootDir, "src", "content");
  try {
    return readdirSync(contentRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && COLLECTION_NAME_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // src/content absent or unreadable — not a content-collection site.
    return [];
  }
}

export function caret(options: CaretOptions = {}): AstroIntegration {
  const resolved = resolveCaretOptions(options);

  // Path prefixes the integration owns once its routes are injected; null until
  // (and unless) config:setup actually injects them (static output / cloud
  // variants skip injection). Read by the routes:resolved collision check.
  let ownedRoutePrefixes: string[] | null = null;

  return {
    name: "caretcms",
    hooks: {
      "astro:config:setup": ({ command, config, logger, addMiddleware, injectRoute, injectScript, updateConfig, addDevToolbarApp }) => {
        const isStaticOutput = config.output === "static";

        // A typo'd option (`mountpath`) used to silently fall back to its
        // default — the user "configured" something that never took effect.
        for (const unknown of unknownOptionWarnings(options)) {
          logger.warn(`[caretcms] unknown option ${unknown} — ignored.`);
        }

        // Zero-config collection detection: when the user hasn't chosen a storage
        // adapter and the project has Astro content collections under src/content,
        // default to markdownStorage() so the Studio surfaces those collections
        // immediately instead of the "No collections yet" empty state. Skipped in
        // cloud mode (storage is remote) and whenever an explicit `storage` was
        // passed — setting `storage: filesystemStorage()` is the opt-out. This
        // only picks the adapter; typed field labels still come from `schemas`
        // (e.g. derived via @caretcms/zod), which stays opt-in to keep core
        // Zod-agnostic.
        const userSetStorage = isProviderReference(
          (options as { storage?: unknown }).storage,
          "storage",
        );
        if (!userSetStorage && resolved.mode !== "cloud") {
          const projectRoot = fileURLToPath(config.root);
          const detected = detectContentCollections(projectRoot);
          if (detected.length > 0) {
            // Pin the adapter to the SAME root the detection used — its own
            // default is process.cwd(), which diverges from config.root under
            // `astro dev --root`, monorepo task runners, etc., producing
            // "detected collections" in the log while the Studio reads an
            // empty directory somewhere else.
            resolved.storage = markdownStorage({
              contentRoot: join(projectRoot, "src", "content"),
              metaRoot: join(projectRoot, ".caretcms"),
            });
            logger.info(
              `[caretcms] Detected Astro content collections under src/content (${detected.join(", ")}) — defaulting storage to markdownStorage(). Pass an explicit \`storage\` to override; add \`schemas\` (e.g. via @caretcms/zod) for typed fields.`,
            );
          }
        }

        // Zero-config dev login: when running `astro dev` in an editable
        // (embedded, server-output) setup with no real password configured,
        // mint a throwaway password so a freshly-installed site can sign in
        // immediately. Only generated for `command === "dev"`, so production
        // builds bake an empty define and stay locked.
        const hasEnvPassword =
          (process.env.CARET_EDIT_PASSWORD ?? process.env.EDIT_PASSWORD ?? "").trim()
            .length > 0;
        const devEditorPassword =
          command === "dev" &&
          !isStaticOutput &&
          resolved.mode !== "cloud" &&
          !hasEnvPassword
            ? randomBytes(4).toString("hex")
            : null;

        updateConfig({
          vite: {
            define: {
              __ASTRO_CARET_MOUNT_PATH__: JSON.stringify(resolved.mountPath),
              __ASTRO_CARET_API_BASE_PATH__: JSON.stringify(resolved.apiBasePath),
              __ASTRO_CARET_EDITOR_HOME__: JSON.stringify(resolved.editorHome),
              __ASTRO_CARET_MODE__: JSON.stringify(resolved.mode),
              __ASTRO_CARET_THEME_CONFIG__: JSON.stringify(JSON.stringify(resolved.theme)),
              __ASTRO_CARET_BRAND_CONFIG__: JSON.stringify(JSON.stringify(resolved.brand)),
              __ASTRO_CARET_DEV_PASSWORD__: JSON.stringify(devEditorPassword ?? ""),
            },
            plugins: [
              createRuntimeProvidersPlugin(resolved),
              createSchemasPlugin(resolved.schemas),
            ],
          },
        });

        const clientConfig = {
          mode: resolved.mode,
          mountPath: resolved.mountPath,
          apiBasePath: resolved.apiBasePath,
          cloud: resolved.cloud ?? undefined,
          allowedClasses: resolved.allowedClasses,
        };

        // Dev Toolbar app: a login-free, dev-only view of the data-caret
        // bindings on the current page — the complement to the in-editor
        // "Show All" button, which needs an authenticated editor session.
        // Registered for every mode/output (it's pure introspection and is
        // useful even in static mode); only runs under `astro dev`, so it
        // adds no production surface.
        if (command === "dev") {
          addDevToolbarApp({
            id: "caretcms",
            name: "CaretCMS",
            icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`,
            entrypoint: new URL("../static/cms/dev-toolbar/app.js", import.meta.url),
          });
          // mountPath/apiBasePath for the toolbar's Studio deep-links. Unlike
          // window.__CARET__ (set only after auth), this is always present in
          // dev so the toolbar can build links before anyone signs in.
          injectScript(
            "page",
            `window.__CARET_DEV__=${JSON.stringify({ mountPath: resolved.mountPath, apiBasePath: resolved.apiBasePath })};`,
          );
        }

        if (resolved.mode === "cloud") {
          injectScript("page", buildCloudBootstrapScript(clientConfig, resolved.cloud!));
          logger.warn(
            "[caretcms] mode: 'cloud' is alpha. The hosted control plane is not yet generally available — bootstrap requests will fail silently against placeholder endpoints. Use embedded mode for production today.",
          );
          logger.info(
            `[caretcms] cloud mode loaded (projectId=${resolved.cloud!.projectId}, endpoint=${resolved.cloud!.endpoint}, static=${isStaticOutput})`,
          );
          return;
        }

        if (isStaticOutput) {
          logger.warn(
            `[caretcms] ${resolved.mode} mode needs Astro server output for local editing routes. Static output detected, so embedded CMS middleware and routes were skipped.`,
          );
          return;
        }

        addMiddleware({
          order: "pre",
          entrypoint: new URL("./runtime/middleware.js", import.meta.url),
        });

        ownedRoutePrefixes = [
          ...(resolved.enableAdmin ? [resolved.mountPath] : []),
          resolved.apiBasePath,
          "/__caret",
        ];

        if (resolved.enableAdmin) {
          injectRoute({
            pattern: resolved.mountPath,
            entrypoint: new URL("./runtime/routes/admin.js", import.meta.url),
          });
          injectRoute({
            pattern: `${resolved.mountPath}/cms`,
            entrypoint: new URL("./runtime/routes/studio-home.js", import.meta.url),
          });
          injectRoute({
            pattern: `${resolved.mountPath}/cms/[collection]`,
            entrypoint: new URL("./runtime/routes/collection-list.js", import.meta.url),
          });
          injectRoute({
            pattern: `${resolved.mountPath}/cms/[collection]/[id]`,
            entrypoint: new URL("./runtime/routes/admin-entry.js", import.meta.url),
          });
        }

        injectRoute({
          pattern: `${resolved.apiBasePath}/entries`,
          entrypoint: new URL("./runtime/routes/entries.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/mutate`,
          entrypoint: new URL("./runtime/routes/mutate.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/schema`,
          entrypoint: new URL("./runtime/routes/schema.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/publish`,
          entrypoint: new URL("./runtime/routes/publish.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/draft`,
          entrypoint: new URL("./runtime/routes/draft.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/collections-metadata`,
          entrypoint: new URL("./runtime/routes/collections-metadata.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/auth/login`,
          entrypoint: new URL("./runtime/routes/auth-login.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/auth/session`,
          entrypoint: new URL("./runtime/routes/auth-session.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/auth/logout`,
          entrypoint: new URL("./runtime/routes/auth-logout.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/theme.css`,
          entrypoint: new URL("./runtime/routes/theme-stylesheet.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/history`,
          entrypoint: new URL("./runtime/routes/history.js", import.meta.url),
        });
        injectRoute({
          pattern: `${resolved.apiBasePath}/upload`,
          entrypoint: new URL("./runtime/routes/upload.js", import.meta.url),
        });

        if (resolved.enableInlineEditor) {
          injectRoute({
            pattern: "/__caret/[...path]",
            entrypoint: new URL("./runtime/routes/editor-assets.js", import.meta.url),
          });

          injectScript(
            "page",
            `(function(){
  // Bootstrap when the page has an explicit data-caret binding OR stega-encoded
  // content (key hidden in a string via U+E0000); the latter has no attribute
  // until the editor hydrates it, so attribute-only detection would miss it.
  if(!document.querySelector('[data-caret]') && !/\\u{E0000}/u.test(document.body&&document.body.textContent||''))return;
  fetch(${JSON.stringify(`${resolved.apiBasePath}/auth/session`)},{credentials:'same-origin'})
    .then(function(response){return response.ok?response.json():null;})
    .then(function(session){
      if(!session||session.authenticated!==true)return;
      var l=document.createElement('link');l.rel='stylesheet';l.href='/__caret/editor.css';document.head.appendChild(l);
      window.__CARET__=${JSON.stringify(clientConfig)};
      var s=document.createElement('script');s.type='module';s.src='/__caret/editor.js?v='+Date.now();document.head.appendChild(s);
    })
    .catch(function(){});
})();`,
          );
        }

        logger.info(
          `[caretcms] core loaded (mode=${resolved.mode}, mountPath=${resolved.mountPath}, apiBasePath=${resolved.apiBasePath}, storage=${describeProvider(
            resolved.storage,
          )}, uploads=${describeProvider(resolved.uploads)}, enableAdmin=${resolved.enableAdmin}, inlineEditor=${resolved.enableInlineEditor})`,
        );

        if (devEditorPassword) {
          logger.warn(
            `[caretcms] No CARET_EDIT_PASSWORD set — temporary dev login enabled so you can sign in now:\n` +
              `\n` +
              `    password: ${devEditorPassword}\n` +
              `\n` +
              `  Sign in at ${resolved.mountPath}. To make it permanent, add\n` +
              `  CARET_EDIT_PASSWORD=<your-password> to a .env file and restart.\n` +
              `  This temporary password works in dev only; production stays locked.`,
          );
        }
      },

      // Type the middleware's contribution to Astro.locals so user code gets
      // `locals.isEditor: boolean` with autocomplete instead of `any`.
      "astro:config:done": ({ injectTypes }) => {
        injectTypes({
          filename: "types.d.ts",
          content: [
            "declare namespace App {",
            "  interface Locals {",
            "    /** True when the request carries an authenticated CaretCMS editor session (set by the caretcms middleware). */",
            "    isEditor: boolean;",
            "  }",
            "}",
            "",
          ].join("\n"),
        });
      },

      // An existing site may already own a route under /admin or /api/cms —
      // Astro resolves the conflict by file-vs-injected precedence, which
      // silently shadows either the user's page or the CMS login. Name the
      // overlap and the remedy instead of letting it read as "CMS is broken".
      "astro:routes:resolved": ({ routes, logger }) => {
        if (!ownedRoutePrefixes) return; // nothing injected (static/cloud skip)
        const owned = ownedRoutePrefixes;
        for (const route of routes) {
          if (route.origin !== "project") continue;
          const hit = owned.find(
            (p) => route.pattern === p || route.pattern.startsWith(`${p}/`),
          );
          if (!hit) continue;
          logger.warn(
            `[caretcms] your route ${route.pattern} (${route.entrypoint}) overlaps the CMS route space "${hit}" — one of them will be shadowed. ` +
              `Move your route, or relocate the CMS with caret({ ${hit === resolved.apiBasePath ? 'apiBasePath: "/your-api-path"' : 'mountPath: "/your-admin-path"'} }).`,
          );
        }
      },
    },
  };
}

export default caret;
