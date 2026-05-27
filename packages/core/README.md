# @caretcms/core

Inline editing and live content collections for Astro. Add one HTML attribute to make any element editable, and use Astro's live loaders to query CMS data with `getLiveEntry` / `getLiveCollection` (stable on Astro 6, experimental on Astro 5.10+).

## Install

```bash
npm install @caretcms/core
```

## Setup

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import caret from '@caretcms/core';

export default defineConfig({
  output: 'server',
  integrations: [caret()],
});
```

## Inline editing

Add `data-caret` attributes to your templates:

```html
<main data-caret-scope="pages::home">
  <h1 data-caret="headline">Welcome to my site</h1>
  <p data-caret="intro">This text is editable.</p>
  <img data-caret="hero_image" src="/default.jpg" alt="Hero" />
</main>
```

Set a password and start the dev server:

```bash
CARET_EDIT_PASSWORD=devpass npm run dev
```

Log in at `/admin`, then click any annotated element on the page to edit it.

The inline editor only bootstraps on pages that contain `data-caret` bindings and only after
`GET /api/cms/auth/session` confirms an authenticated editor session. Session cookies are issued
as `HttpOnly`, `SameSite=Lax`, and automatically add `Secure` on HTTPS requests.

## Live content collections

You can also wire collections into Astro's native content layer using `caretLoader`. This lets you query CMS data with `getLiveEntry` and `getLiveCollection` from `astro:content` — the same API you use for any Astro live collection.

> **Astro 6:** stable, no flag required.
> **Astro 5.10+:** available behind `experimental.liveContentCollections: true` in `astro.config.*`.
> **Astro 5.0–5.9:** the live-loader API (`defineLiveCollection`, `getLiveEntry`, `getLiveCollection`) doesn't exist; use `data-caret` inline editing, `bindEntry()`, and `loadEntry()` instead.

### 1. Define collections

Create `src/caret.config.ts`:

```ts
import { defineLiveCollection } from 'astro:content';
import { caretLoader } from '@caretcms/core';

const pages = defineLiveCollection({
  loader: caretLoader('pages'),
});

const site = defineLiveCollection({
  loader: caretLoader('site'),
});

export const collections = { pages, site };
```

### 2. Query in pages

```astro
---
import { getLiveEntry } from 'astro:content';

const { entry: home } = await getLiveEntry('pages', 'home');
---
<h1>{home?.data.headline}</h1>
```

### 3. Both approaches work together

Inline editing (`data-caret`) and live collections read from the same storage adapter. Edits made inline are immediately visible through `getLiveEntry` / `getLiveCollection`, and vice versa. Use whichever approach fits the context:

- `data-caret` for visual, in-place editing of rendered pages
- `getLiveEntry` / `getLiveCollection` for programmatic data access in frontmatter

## Explicit schemas (optional)

By default, Studio infers field types from your stored data. For better field labels, validation, and widget hints, pass JSON Schemas via the integration config:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import { z } from 'astro/zod';
import caret from '@caretcms/core';

const PageSchema = z.object({ headline: z.string(), intro: z.string() });

export default defineConfig({
  output: 'server',
  integrations: [
    caret({
      schemas: {
        pages: z.toJSONSchema(PageSchema),
      },
    }),
  ],
});
```

When provided, Studio uses these for field names, types, and editor widgets instead of guessing from the first entry.

## What you get

- **Inline editing** on any `data-caret` element (text and images)
- **Live content collections** via `caretLoader` for `getLiveEntry` / `getLiveCollection` (Astro 6 stable, Astro 5.10+ behind `experimental.liveContentCollections`)
- **Content Studio** at `/admin/cms` for structured CRUD
- **Section composer** for reordering and spacing page sections
- **Response rewriting** middleware — stored edits replace template defaults at render time
- **Scoped bindings** via `data-caret-scope` to reduce repetition
- **Revision safety** with optimistic locking and restore from history
- **Storage adapters** — filesystem (default), in-memory, or custom via `StorageAdapter` interface

## Cloudflare deployment

```bash
npm install @caretcms/cloudflare
```

```js
import caret from '@caretcms/core';
import { cloudflareStorage, r2Uploads } from '@caretcms/cloudflare';

export default defineConfig({
  output: 'server',
  integrations: [
    caret({
      storage: cloudflareStorage({ binding: 'CMS_KV' }),
      uploads: r2Uploads({ binding: 'CMS_R2' }),
    }),
  ],
});
```

## API

All routes are under `/api/cms` by default (configurable via `apiBasePath`):

| Route | Method | Purpose |
|---|---|---|
| `/api/cms/entries` | GET | List entries by collection |
| `/api/cms/schema` | GET | Collection schema (explicit or inferred) |
| `/api/cms/mutate` | POST | Save content mutations |
| `/api/cms/history` | GET | Entry revision history |
| `/api/cms/upload` | POST | File uploads |
| `/api/cms/auth/login` | POST | Editor login |
| `/api/cms/auth/session` | GET | Editor session status |
| `/api/cms/auth/logout` | POST | Editor logout |

`/api/cms/auth/session` returns `{ authenticated: boolean }` and is what the inline editor uses to
decide whether it should mount on the current page.

## Configuration

```js
caret({
  mountPath: '/admin',          // Admin UI base path (default: /admin)
  apiBasePath: '/api/cms',      // API route prefix (default: /api/cms)
  enableAdmin: true,            // Inject admin pages (default: true)
  enableInlineEditor: true,     // Inject inline editor (default: true)
  storage: filesystemStorage(), // Storage adapter (default: filesystem)
  uploads: localUploads(),      // Upload handler (default: local filesystem)
  schemas: {},                  // Optional JSON Schema map for Studio (default: inferred)
})
```

## Requirements

- Astro 5 or 6
- Node 20.19.1+ or 22.12.0+
- Server output mode (for embedded editing routes)

## License

MIT
