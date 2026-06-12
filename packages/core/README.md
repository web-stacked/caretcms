# @caretcms/core

Inline editing and live content collections for Astro. Add one HTML attribute to make any element editable, and use Astro's live loaders to query CMS data with `getLiveEntry` / `getLiveCollection` (stable on Astro 6, experimental on Astro 5.10+).

## Install

```bash
npm install @caretcms/core @astrojs/node
```

Embedded editing renders on the server, so `output: 'server'` needs an SSR
adapter — `@astrojs/node` above, or whichever adapter matches your host.

## Setup

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import caret from '@caretcms/core';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [caret()],
});
```

**Already have Astro content collections?** If your project has collections under
`src/content/` and you haven't set `storage`, CaretCMS auto-selects
`markdownStorage()` so the Studio lists those collections immediately (instead of
"No collections yet") and edits write back to your `.md` frontmatter. Pass an
explicit `storage` to override — `storage: filesystemStorage()` opts back out.

## Choose your path

CaretCMS gives you two ways to make content editable. They share one storage layer and one login — you can mix them on the same site — but they answer different questions. Start at the top; reach for the next row only when you need it.

| Start here if… | Use | What you write |
|---|---|---|
| You have static markup (a hero, an about page) and just want to click words/images and change them | **Inline editing** | `data-caret` attributes on the elements |
| The same fields repeat or you want short attribute names | **Scoped inline editing** | a `data-caret-scope` wrapper + short `data-caret` names |
| Your content is dynamic data you query in frontmatter (a blog index, a list of products) | **Live collections** | `caretLoader` in `src/caret.config.ts`, then `getLiveEntry` / `getLiveCollection` |

**The binding model in one line:** every edit is addressed as `collection::id::field`. Inline editing lets you spell that out in pieces — `data-caret-scope="pages::home"` sets `collection::id`, and `data-caret="headline"` fills in the `field`, so the element above resolves to `pages::home::headline`. Live collections address the same `collection` + `id` from frontmatter instead. Same content, same storage — two ways to reach it.

> Adding `data-caret` to an existing site by hand? `npx @caretcms/caretize` scans your Astro
> project and interactively annotates your templates for you. The attributes below are all you
> need either way — caretize just writes them.

## Inline editing

Add `data-caret` attributes to your templates:

```html
<main data-caret-scope="pages::home">
  <h1 data-caret="headline">Welcome to my site</h1>
  <p data-caret="intro">This text is editable.</p>
  <img data-caret="hero_image" src="/default.jpg" alt="Hero" />
</main>
```

Start the dev server:

```bash
npm run dev
```

With no password configured, a **temporary dev password is printed in the terminal** (dev only —
production stays locked). To set a permanent one, add `CARET_EDIT_PASSWORD=<your-password>` to a
`.env` file.

Log in at `/admin`, then click any annotated element on the page to edit it. The content Studio
lives at `/admin/cms`.

The inline editor only bootstraps on pages that contain `data-caret` bindings and only after
`GET /api/cms/auth/session` confirms an authenticated editor session. Session cookies are issued
as `HttpOnly`, `SameSite=Lax`, and automatically add `Secure` on HTTPS requests.

When you're signed in and land on a live page that has **no** `data-caret` bindings yet, CaretCMS
shows a small "signed in · no editable fields on this page" hint pointing you at the next step —
so a page that isn't annotated yet reads as "nothing to edit here" rather than "is this broken?".
The hint is editor-only (anonymous visitors never see it) and never appears inside the Studio.

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

**Already describe your collections with Zod?** If you have a `content.config.ts` Zod schema,
don't write it twice — `@caretcms/zod` derives the Studio schema from that single source:

```js
// astro.config.mjs
import { schemaFromZod } from '@caretcms/zod';
import { blogSchema } from './src/schemas.mjs'; // the same object content.config.ts uses

caret({ schemas: { blog: schemaFromZod(blogSchema) } });
```

(Keep your Zod schemas in a plain module that imports only `zod` — not `astro:content` — so both
`content.config.ts` and `astro.config` can import them.) Schemas remain optional: with
auto-detected `markdownStorage` the Studio already shows each collection with fields inferred from
existing entries; deriving from Zod just adds proper labels, types, and widget hints.

## What you get

- **Inline editing** on any `data-caret` element (text and images)
- **Live content collections** via `caretLoader` for `getLiveEntry` / `getLiveCollection` (Astro 6 stable, Astro 5.10+ behind `experimental.liveContentCollections`)
- **Content Studio** at `/admin/cms` for structured CRUD
- **Section composer** for reordering and spacing page sections
- **Response rewriting** middleware — stored edits replace template defaults at render time
- **Scoped bindings** via `data-caret-scope` to reduce repetition
- **Dev Toolbar app** — in `astro dev`, inspect and highlight every binding on the page (no login required), grouped by entry with deep-links into Studio
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
  storage: filesystemStorage(), // Storage adapter (default: markdownStorage when
                                //   src/content collections exist, else filesystem)
  uploads: localUploads(),      // Upload handler (default: local filesystem)
  schemas: {},                  // Optional JSON Schema map for Studio (default: inferred)
})
```

## Rendering & output

CaretCMS injects your stored edits at request time in middleware (the "response rewriting" step),
so any page that shows editable content must be **server-rendered** — that's why the integration
needs `output: 'server'`. On `output: 'static'`, the editing middleware and routes are skipped (you'll
see a warning) because prerendered HTML is produced at build time, before there's a request to rewrite.

Mostly-static site? You don't lose prerendering everywhere — under `output: 'server'` you can opt
individual pages that *don't* show live edits back into static generation with
`export const prerender = true`. Pages that surface editable content should stay server-rendered so
edits appear immediately instead of only after a rebuild.

> **Migrating a static site:** switching to `output: 'server'` flips the default for
> `getStaticPaths`-based pages — they no longer receive props at build time. Add
> `export const prerender = true` to keep such a page statically generated, or refactor it to fetch
> its data at request time. This is standard Astro output behavior, not specific to CaretCMS.

## What gets written to disk

The default (embedded) providers write inside your project:

| Path | What | Written by |
|---|---|---|
| `.caret/data/` | entry JSON | `filesystemStorage()` (default) |
| `.caret/drafts/` | per-editor draft overlays | `filesystemStorage()` |
| `.caretcms/` | revisions + history sidecar | both filesystem and markdown storage |
| `src/content/**.md` | frontmatter edits | `markdownStorage()` (auto-selected when you have content collections) |
| `public/uploads/` | uploaded images | `localUploads()` (default) |

Recommended `.gitignore` for the transient state (keep `.caret/data/` or your
`src/content` edits if git IS your content store — see the commit-on-publish
workflow in [docs/deployment.md](../../docs/deployment.md)):

```gitignore
.caretcms/
.caret/drafts/
public/uploads/
```

## Production checklist

- `CARET_EDIT_PASSWORD` — the editor password. Without it, production is locked (no dev fallback).
- `CARET_SESSION_SECRET` — **required in production** when a password is set; sessions are
  HMAC-signed with it. Generate one with `openssl rand -base64 32`. If it's missing, logins
  return a configuration error and existing sessions are treated as signed out.
- `markdownStorage()` edits `src/content/*.md` **at request time** — a dev/git workflow. In
  production, pair it with commit-on-publish + a CI rebuild (fields rendered through
  `getCollection()` are baked at build time and only refresh on rebuild), or use a server-side
  adapter like [`@caretcms/cloudflare`](https://www.npmjs.com/package/@caretcms/cloudflare).
- `localUploads()` writes to `public/uploads`, which built sites serve from `dist/client` —
  files uploaded *after* the build won't be served. Treat it as dev-only and use R2 (or your
  own `UploadHandler`) in production.
- Defaults resolve paths from the **server process's working directory**; run the built server
  from your project root, or pass explicit paths (`filesystemStorage({ dataRoot })`,
  `markdownStorage({ contentRoot })`, `localUploads({ uploadsDir })`).

## Requirements

- Astro 5 or 6
- Node 20.19.1+ or 22.12.0+
- Server output mode (for embedded editing routes) plus an SSR adapter

## License

MIT
