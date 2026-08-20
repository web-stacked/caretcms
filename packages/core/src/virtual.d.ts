declare module "virtual:caretcms/providers" {
  import type { IdentityAdapter, StorageAdapter, UploadHandler } from "./types.js";

  export function loadConfiguredStorage(): Promise<StorageAdapter | null>;
  export function loadConfiguredUploadHandler(): Promise<UploadHandler | null>;
  export function loadConfiguredIdentityAdapter(): Promise<IdentityAdapter | null>;
  /** Per-tag class allowlist for rich-text sanitization (from caret() config). */
  export const allowedClasses: Record<string, string[]>;
  export const delivery: {
    mode: "server" | "static";
    bake: boolean;
    publish: {
      webhookUrl: string | null;
      method: "POST" | "PUT";
      headers: Record<string, string>;
    };
  };
  /** Whether the inline editor is enabled — gates the authed empty-state hint. */
  export const enableInlineEditor: boolean;
  export const mountPath: string;
  export const apiBasePath: string;
}

declare module "virtual:caretcms/schemas" {
  export const registered: boolean;
}
