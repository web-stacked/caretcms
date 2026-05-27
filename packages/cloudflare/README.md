# @caretcms/cloudflare

Cloudflare-native storage, uploads, and runtime helpers for CaretCMS.

## Usage

```js
import { defineConfig } from "astro/config";
import caret from "@caretcms/core";
import { cloudflareStorage, r2Uploads } from "@caretcms/cloudflare";

export default defineConfig({
  output: "server",
  integrations: [
    caret({
      mode: "embedded",
      storage: cloudflareStorage({ binding: "CMS_KV" }),
      uploads: r2Uploads({ binding: "CMS_R2" }),
    }),
  ],
});
```

## Exports

- `cloudflareStorage()`
- `cloudflareStorageProvider()`
- `CloudflareKvStorageAdapter`
- `r2Uploads()`
- `r2UploadsProvider()`
- `R2UploadHandler`
- `getCloudflareRuntimeEnv()`
