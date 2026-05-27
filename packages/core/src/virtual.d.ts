declare module "virtual:caretcms/providers" {
  import type { StorageAdapter, UploadHandler } from "./types.js";

  export function loadConfiguredStorage(): Promise<StorageAdapter | null>;
  export function loadConfiguredUploadHandler(): Promise<UploadHandler | null>;
}

declare module "virtual:caretcms/schemas" {
  export const registered: boolean;
}
