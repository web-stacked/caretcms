import { randomBytes } from "node:crypto";
import type { AstroIntegration } from "astro";
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
export { InMemoryAdapter } from "./runtime/storage/in-memory-adapter.js";
export { FilesystemUploadHandler } from "./runtime/storage/filesystem-upload-handler.js";
export { bindEntry } from "./runtime/bind.js";
export { caretLoader, CaretLoaderError } from "./loader.js";
export type { CaretLiveLoader } from "./loader.js";

const VIRTUAL_PROVIDER_MODULE_ID = "virtual:caretcms/providers";
const RESOLVED_VIRTUAL_PROVIDER_MODULE_ID = `\0${VIRTUAL_PROVIDER_MODULE_ID}`;
const VIRTUAL_SCHEMAS_MODULE_ID = "virtual:caretcms/schemas";
const RESOLVED_VIRTUAL_SCHEMAS_MODULE_ID = `\0${VIRTUAL_SCHEMAS_MODULE_ID}`;
const FILESYSTEM_STORAGE_ENTRYPOINT = "@caretcms/core/providers/storage/filesystem";
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
   * Optional collection schemas as JSON Schema objects. When provided, Studio
   * uses these for field labels, types, and validation instead of inferring
   * schema from the first entry.
   *
   * Keys are collection names, values are JSON Schema objects (e.g. produced
   * by z.toJSONSchema() from a Zod schema).
   */
  schemas?: Record<string, JsonSchemaDefinition>;
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
  cloud: CaretCloudOptions | null;
  schemas: Record<string, JsonSchemaDefinition>;
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

function resolveCaretOptions(options: CaretOptions): ResolvedCaretOptions {
  const mode = normalizeMode(options.mode);
  const defaults = defaultProviders(mode);
  const cloud =
    mode === "cloud"
      ? normalizeCloudOptions((options as Extract<CaretOptions, { mode: "cloud" }>).cloud)
      : null;

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
    cloud,
    schemas: options.schemas ?? {},
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

export function caret(options: CaretOptions = {}): AstroIntegration {
  const resolved = resolveCaretOptions(options);

  return {
    name: "caretcms",
    hooks: {
      "astro:config:setup": ({ command, config, logger, addMiddleware, injectRoute, injectScript, updateConfig }) => {
        const isStaticOutput = config.output === "static";

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
        };

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
    },
  };
}

export default caret;
