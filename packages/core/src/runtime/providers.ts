import type { StorageAdapter, UploadHandler } from "../types.js";
// virtual.d.ts declares the full export shape the integration generates — keep
// the two in sync (the vitest stub in tests/unit/stubs mirrors them too). The
// `Partial` wrapper below keeps runtime null-safety for environments that load
// this module without the Vite plugin (every access still has a fallback).
import * as runtimeProviders from "virtual:caretcms/providers";

type ProviderModule = Partial<typeof runtimeProviders>;

type RuntimeServices = {
  adapter: StorageAdapter;
  uploadHandler: UploadHandler;
  /** Per-tag class allowlist for rich-text sanitization (from caret() config). */
  allowedClasses: Record<string, string[]>;
  /** Whether the inline editor is enabled — gates the authed empty-state hint. */
  enableInlineEditor: boolean;
  /** CMS mount/API base paths, so the empty-state hint skips CMS-owned pages. */
  mountPath: string;
  apiBasePath: string;
};

let runtimeServicesPromise: Promise<RuntimeServices> | null = null;
let testServicesOverride: Partial<RuntimeServices> | null = null;
const providerModule = runtimeProviders as ProviderModule;

async function createAdapter(): Promise<StorageAdapter> {
  if (testServicesOverride?.adapter) {
    return testServicesOverride.adapter;
  }

  const configuredAdapter = await providerModule?.loadConfiguredStorage?.();
  if (configuredAdapter) {
    return configuredAdapter;
  }

  throw new Error(
    "[caretcms] No storage provider was configured for the active runtime mode.",
  );
}

async function createUploadHandler(): Promise<UploadHandler> {
  if (testServicesOverride?.uploadHandler) {
    return testServicesOverride.uploadHandler;
  }

  const configuredUploadHandler = await providerModule?.loadConfiguredUploadHandler?.();
  if (configuredUploadHandler) {
    return configuredUploadHandler;
  }

  throw new Error(
    "[caretcms] No upload provider was configured for the active runtime mode.",
  );
}

export async function getRuntimeServices(): Promise<RuntimeServices> {
  if (!runtimeServicesPromise) {
    const inflight = Promise.all([createAdapter(), createUploadHandler()]).then(
      ([adapter, uploadHandler]) => ({
        adapter,
        uploadHandler,
        allowedClasses:
          testServicesOverride?.allowedClasses ?? providerModule?.allowedClasses ?? {},
        enableInlineEditor:
          testServicesOverride?.enableInlineEditor ??
          providerModule?.enableInlineEditor ??
          false,
        mountPath:
          testServicesOverride?.mountPath ?? providerModule?.mountPath ?? "/admin",
        apiBasePath:
          testServicesOverride?.apiBasePath ?? providerModule?.apiBasePath ?? "/api/cms",
      }),
    );
    inflight.catch(() => {
      if (runtimeServicesPromise === inflight) {
        runtimeServicesPromise = null;
      }
    });
    runtimeServicesPromise = inflight;
  }

  return runtimeServicesPromise;
}

export function __setRuntimeServicesForTests(
  services: Partial<RuntimeServices> | null,
): void {
  testServicesOverride = services;
  runtimeServicesPromise = null;
}
