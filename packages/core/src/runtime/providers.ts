import type { StorageAdapter, UploadHandler } from "../types.js";
import * as runtimeProviders from "virtual:caretcms/providers";

type ProviderModule = {
  loadConfiguredStorage?: () => Promise<StorageAdapter | null>;
  loadConfiguredUploadHandler?: () => Promise<UploadHandler | null>;
  allowedClasses?: Record<string, string[]>;
};

type RuntimeServices = {
  adapter: StorageAdapter;
  uploadHandler: UploadHandler;
  /** Per-tag class allowlist for rich-text sanitization (from caret() config). */
  allowedClasses: Record<string, string[]>;
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
