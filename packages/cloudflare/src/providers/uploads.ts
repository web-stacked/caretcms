import { defineUploadProvider, type CaretUploadProvider } from "@caretcms/core";
import { R2UploadHandler, type R2UploadHandlerOptions } from "../adapters/r2-upload.js";

export function r2UploadsProvider(options?: R2UploadHandlerOptions): R2UploadHandler {
  return new R2UploadHandler(options);
}

export function r2Uploads(options?: R2UploadHandlerOptions): CaretUploadProvider {
  return defineUploadProvider({
    entrypoint: "@caretcms/cloudflare/providers/uploads",
    exportName: "r2UploadsProvider",
    options,
  });
}
