import { defineStorageProvider, type CaretStorageProvider } from "@caretcms/core";
import { CloudflareKvStorageAdapter, type CloudflareKvStorageOptions } from "../adapters/kv-storage.js";

export function cloudflareStorageProvider(
  options?: CloudflareKvStorageOptions,
): CloudflareKvStorageAdapter {
  return new CloudflareKvStorageAdapter(options);
}

export function cloudflareStorage(
  options?: CloudflareKvStorageOptions,
): CaretStorageProvider {
  return defineStorageProvider({
    entrypoint: "@caretcms/cloudflare/providers/storage",
    exportName: "cloudflareStorageProvider",
    options,
  });
}
