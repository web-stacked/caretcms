# @caretcms/core

Inline editing, Markdown prose editing, and live content collections for Astro 6
and 7. Add one HTML attribute to make any element editable, or edit supported
blocks rendered from existing `.md` content collections.

![CaretCMS inline editor demo](https://caretcms.com/preview/caretcms-demo.gif)

## Install

```bash
npm install @caretcms/core
```

**Static Astro site?** Use `caret()` — no SSR adapter:

```js
integrations: [caret()],
```

`caret()` auto-detects Astro output: static output gets build-time baking, server
output gets middleware rewriting.

**Server-rendered site?** Add an adapter and server output:

```bash
npm install @astrojs/node
```

```js
output: 'server',
adapter: node({ mode: 'standalone' }),
integrations: [caret()],
```

See [Static delivery](../../docs/static-delivery.md) and [Rendering & output](#rendering--output) below.

## Setup

Fast path for an existing Astro site:

```bash
npx @caretcms/caretize init
npx @caretcms/caretize
npm run dev
```

### Static delivery (default path for static Astro sites)

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import caret from '@caretcms/core';

export default defineConfig({
  // Astro defaults to output: 'static'; caret() auto-selects static delivery.
  integrations: [caret()],
});
```

Enable public access for the R2 bucket and set `R2_PUBLIC_DOMAIN` to that
hostname, or pass `publicBaseUrl` to `r2Uploads()`. Uploads fail with an
actionable configuration error if no public URL is available; Caret core does
not mount an R2 image proxy.

- **`astro dev`** — full authoring: `/admin`, `/api/cms`, inline editor.
- **`astro build`** — bakes stored overrides into generated HTML; authoring routes stay out of production output.
- **Public updates** — after Publish, run CI/build/deploy (optionally via `delivery.publish.webhookUrl`).

### Server delivery (per-request rewriting)

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

Edits are visible to visitors immediately — middleware rewrites HTML on each request.

**Already have Astro content collections?** If your project has collections under
`src/content/` and you haven't set `storage`, CaretCMS auto-selects
`markdownStorage()` so the Studio lists those collections immediately (instead of
"No collections yet") and edits write back to your `.md` files. Pass an
explicit `storage` to override — `storage: filesystemStorage()` opts back out.

### Edit Markdown prose on the page

When Astro renders a `.md` entry through `markdownStorage()`, Caret marks safe
prose blocks automatically. Sign in, click a paragraph or heading, edit it on the
page, then publish the draft to write the change back to the source file.

Caret supports paragraphs, ATX headings, list items, and paragraphs inside
blockquotes. Bold, emphasis, links, inline code, and line breaks round-trip to
Markdown. Code blocks, tables, raw HTML blocks, and MDX stay read-only. Nested
blocks must fit on one source line.

Consecutive top-level paragraphs support Enter to split or insert, Backspace and
Delete to merge, selection deletion, and browser undo. Paste accepts plain text
with paragraph breaks. See [paragraph editing](../../docs/markdown-paragraph-editing.md)
for boundaries, source preservation, preview styling, and browser coverage.

Each draft records the source range and a hash of the original text. If the file
changes before publish, Caret returns a conflict and leaves both the file and the
draft untouched. Set `bodyEditing: false` in `caret()` to disable this feature.

See [Markdown body editing](https://caretcms.com/docs/markdown-body-editing/) for
the full setup, supported syntax, and publish workflow.

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

Log in at `/admin`, then click any tagged element on the page to edit it. The content Studio
lives at `/admin/cms`.

For editable content inside a link, a normal click edits while Command-click
(macOS) or Ctrl-click (Windows/Linux) opens the destination in a new tab. The
editor also shows a collision-aware Open action on hover or keyboard focus;
linked images keep separate Replace image and Open link actions.

The inline editor only bootstraps on pages that contain `data-caret` or `data-caret-md` bindings and only after
`GET /api/cms/auth/session` confirms an authenticated editor session. Session cookies are issued
as `HttpOnly`, `SameSite=Lax`, and automatically add `Secure` on HTTPS requests.

When you're signed in and land on a live page that has **no** editable bindings yet, CaretCMS
shows a small "signed in · no editable fields on this page" hint pointing you at the next step —
so a page that isn't annotated yet reads as "nothing to edit here" rather than "is this broken?".
The hint is editor-only (anonymous visitors never see it) and never appears inside the Studio.

## Live content collections

You can also wire collections into Astro's native content layer using `caretLoader`. This lets you query CMS data with `getLiveEntry` and `getLiveCollection` from `astro:content` — the same API you use for any Astro live collection.

> **Astro 6 and 7:** stable, no experimental flag required.

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

Authenticated live-loader responses hide binding metadata inside string values.
Rendered text uses that metadata for automatic click-to-edit. Strip it before a
value enters an HTML attribute that is not itself editable, such as `href`,
`src`, `alt`, `<title>`, or a meta description:

```astro
---
import { stegaClean } from '@caretcms/core';
const href = stegaClean(home?.data.ctaHref ?? '/');
---
<a href={href}>{home?.data.ctaLabel}</a>
```

### Preview routes and managed publication

Collection metadata can connect Studio entries to their actual site routes and
make publication a reversible visibility state:

```js
caret({
  collections: {
    pages: {
      previewPath: { home: '/', about: '/about' },
      publication: { field: 'published' },
    },
    posts: {
      entryLabel: 'post',
      titleField: 'title',
      thumbnailField: 'cover',
      subtitleField: 'author',
      previewPath: '/blog/{id}',
      publication: { field: 'published' },
    },
  },
})
```

`entryLabel` gives creation actions a project-specific noun. The three field
options control the title, image, and supporting metadata shown on entry cards;
`titleField` also lets the creation dialog start with the title and suggest a
slug that the editor can adjust before creating the entry. Without these
options, Studio uses common field names and falls back to an ID-only creation
flow when the schema has no suitable title field.

Selecting a Studio field first uses the current page when that binding is
present. Otherwise Caret navigates the preview to `previewPath`, then scrolls to
and highlights the field. Preview paths must be same-origin absolute paths.

For a collection with `publication`, public `caretLoader`, `loadEntry`, and
`loadCollection` reads include only entries whose configured field is exactly
`true`. Authenticated editor previews include both published and unpublished
entries. Turning the field off and saving therefore removes the entry publicly
without deleting it; it can be turned on again later. The configured field must
also be a top-level boolean in that collection's explicit schema, so an invalid
publication setup fails during configuration instead of behaving ambiguously.

Astro's native build-time `getCollection()` does not pass through Caret's
request-aware loader. Filter those results explicitly:

```astro
---
import { getCollection } from 'astro:content';
import { isPublishedEntry } from '@caretcms/core/runtime';

const posts = (await getCollection('posts')).filter((post) =>
  isPublishedEntry(post.data),
);
---
```

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
Use each property's `title` for its visible label and `description` for concise
help below the control. `format: "html"` enables the formatted-text editor,
`format: "image"` enables image upload and URL entry, and
`format: "image-gallery"` enables a reorderable gallery.

Long forms can define Studio-only sections with the `x-caret-groups` extension.
Fields not named in a group remain available in an **Other fields** section:

```js
{
  type: 'object',
  'x-caret-groups': [
    { title: 'Page introduction', fields: ['headline', 'intro', 'cover', 'cover_alt'] },
    { title: 'Call to action', fields: ['link_text', 'link_href'] },
  ],
  properties: {
    headline: { type: 'string', title: 'Headline' },
    intro: { type: 'string', title: 'Introduction', format: 'html' },
    cover: { type: 'string', title: 'Cover image', format: 'image' },
    cover_alt: {
      type: 'string',
      title: 'Cover alternative text',
      description: 'Describe the image for people who cannot see it.',
    },
    link_text: { type: 'string', title: 'Link text' },
    link_href: { type: 'string', title: 'Link destination', format: 'uri' },
  },
}
```

For repeatable object fields, `id`, `width`, and `height` are shown under
**Technical details**. Set `x-caret-technical: true` on another property to place
it there as well. Image, alternative text, title, and caption stay in the main
item editor.

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
- **Live content collections** via `caretLoader` for `getLiveEntry` / `getLiveCollection` on Astro 6 and 7
- **Content Studio** at `/admin/cms` for structured CRUD
- **Section composer** for reordering and spacing page sections
- **Response rewriting** middleware (server delivery) or **build-time HTML bake** (static delivery)
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
| `/api/cms/deployment` | GET | Provider-backed status for the editor's latest accepted deployment |
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
  delivery: 'auto',             // 'auto' | 'static' | 'server' | { mode, bake, publish }
  storage: filesystemStorage(), // Storage adapter (default: markdownStorage when
                                //   src/content collections exist, else filesystem)
  uploads: localUploads(),      // Upload handler (default: local filesystem)
  deployment: undefined,        // Optional build/deployment status provider
  schemas: {},                  // Optional JSON Schema map for Studio (default: inferred)
  collections: {},              // Labels, capabilities, preview paths, publication
  locale: 'en',                 // 'en' | 'es'; dictionary overrides are also supported
  bodyEditing: true,            // Inline editing for rendered Markdown prose
})
```

### Optional named identity adapter

Shared-password mode remains the zero-dependency default. Server deployments can
instead configure an authoritative identity provider:

```js
import caret, { defineIdentityProvider } from '@caretcms/core';

caret({
  identity: defineIdentityProvider({
    entrypoint: './src/caret-identity.ts',
    exportName: 'identityProvider',
    options: { loginOrigin: 'https://login.example.com' },
  }),
});
```

The provider module exports a factory returning an `IdentityAdapter`:

```ts
import type { IdentityAdapter } from '@caretcms/core';

export function identityProvider(options: { loginOrigin: string }): IdentityAdapter {
  return {
    async authenticate(request) {
      // Verify a trusted session/header. Return null to deny authentication.
      // Return null to deny access. IDs must match /^[A-Za-z0-9_-]{1,64}$/.
      return { id: 'editor_01', name: 'Alex Rivera', roles: ['editor'] };
    },
    loginUrl({ redirectTo }) {
      return `${options.loginOrigin}/login?returnTo=${encodeURIComponent(redirectTo)}`;
    },
    logoutUrl({ redirectTo }) {
      return `${options.loginOrigin}/logout?returnTo=${encodeURIComponent(redirectTo)}`;
    },
    async authorize({ identity, action, collection }) {
      if (identity.roles?.includes('admin')) return true;
      if (action === 'edit') return collection === 'pages';
      if (action === 'publish') return identity.roles?.includes('reviewer') === true;
      return false;
    },
  };
}
```

When `identity` is configured it is authoritative: Caret does not fall back to
the shared password. Authentication errors and unsafe IDs fail closed. Named
identity is exposed by `/api/cms/auth/session`, shown in Studio, used as the
private-preview overlay key, and attached to new history snapshots. Only trust
identity headers when a proxy strips client-supplied copies and writes its own.
The optional `authorize` hook controls edit, publish, delete, collection-management,
and upload writes. When present, all content saves go to per-editor drafts so a
writer cannot bypass publish permission in server delivery. See the
[authorization policy](../../docs/authorization-policy.md) for exact action
semantics, backward-compatible defaults, and review-workflow boundaries.

The editor distinguishes unsaved browser changes, saved private drafts, live
shared changes, and configured entry visibility. Markdown body edits always stay
in a draft until Publish, including under server delivery. See
[saving, drafts, and visibility](../../docs/saving-and-visibility.md) for the
complete behavior across delivery modes, permission policies, and sign-out.

## Rendering & output

CaretCMS defaults to automatic delivery. With `caret()` or `delivery: 'auto'`, Astro
`output: 'static'` uses static delivery and Astro `output: 'server'` uses server
delivery.

| | **Static delivery** | **Server delivery** |
|---|---|---|
| Config | `caret()` on default/static output | `caret()` on `output: 'server'` + adapter |
| Public HTML | Baked at `astro build` | Rewritten per request in middleware |
| Production CMS routes | Not shipped in static output | `/admin`, `/api/cms` live on the server |
| Visitor sees edits | After publish + rebuild | Immediately after save |
| SSR adapter | Not required | Required |

### Static delivery

Use when your site stays `output: 'static'`. Local authoring works in `astro dev`; production
is plain static files with content baked in. `caret()` is enough; pass `delivery`
only when you want to configure bake/publish behavior or explicitly pin the mode.

```js
caret({
  delivery: {
    // mode defaults to 'auto', so static Astro output still uses static delivery
    bake: true,
    publish: {
      webhookUrl: 'https://ci.example.com/hooks/rebuild',
      timeoutMs: 5000, // bounded webhook wait; 1–30000 ms
    },
  },
})
```

Use `delivery: 'static'` when you want the integration to error if Astro output is
changed away from static.

Full guide: [docs/static-delivery.md](../../docs/static-delivery.md).
Draft migration, conflicts, interrupted publication, and deployment retries:
[publish recovery](../../docs/publish-recovery.md).

The webhook's 2xx response means accepted, not deployed. Configure a
`DeploymentStatusProvider` to show provider-backed Deploying, Live, and failed
states; Live requires evidence for the published commit or every target entry
revision. The bundled `simulatedDeployment()` provider exercises the complete
local flow. `githubDeployment()` reads exact-correlation build evidence from the
GitHub Deployments API, including progress, failure, environment URL, commit,
and published revisions. See
[deployment completion status](../../docs/deployment-status.md).

### Server delivery

Middleware injects stored edits at request time. Requires `output: 'server'` (or compatible
adapter host). Mostly-static site? Under server output you can keep individual pages static
with `export const prerender = true`; pages with editable content should stay server-rendered.

> **Migrating a static site to server delivery:** switching to `output: 'server'` changes
> how `getStaticPaths` pages receive props. Add `export const prerender = true` to keep a
> page static, or fetch at request time. This is standard Astro behavior, not CaretCMS-specific.

## What gets written to disk

The default (embedded) providers write inside your project:

| Path | What | Written by |
|---|---|---|
| `.caret/data/` | entry JSON | `filesystemStorage()` (default) |
| `.caret/drafts/` | per-editor draft overlays | `filesystemStorage()` |
| `.caretcms/` | revisions + history sidecar | both filesystem and markdown storage |
| `src/content/**.md` | frontmatter and published prose edits | `markdownStorage()` (auto-selected when you have content collections) |
| `public/uploads/` | uploaded images | `localUploads()` (default) |

Recommended `.gitignore` for the transient state (keep `.caret/data/` or your
`src/content` edits if git IS your content store — see the commit-on-publish
workflow in [docs/deployment.md](../../docs/deployment.md)):

```gitignore
.caretcms/
.caret/drafts/
public/uploads/
```

Multiline literal/folded strings and source-preserving saves are supported by
Markdown storage. See [frontmatter compatibility](../../docs/markdown-frontmatter.md)
for supported forms and formatting limits.

## Production checklist

- `CARET_EDIT_PASSWORD` — the editor password. Without it, production is locked (no dev fallback).
- `CARET_SESSION_SECRET` — **required in production** when a password is set; sessions are
  HMAC-signed with it. Generate one with `openssl rand -base64 32`. If it's missing, logins
  return a configuration error and existing sessions are treated as signed out.
- Rotate `CARET_EDIT_PASSWORD` and `CARET_SESSION_SECRET` together, then restart or redeploy
  every instance. Changing the session secret immediately invalidates all existing editor
  cookies; changing only the password does not revoke sessions that are already signed in.
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

Password mode is deliberately a single shared-editor workflow: it has no named users, roles,
or per-user attribution. Teams needing those controls should configure the authoritative
identity adapter described above.

## Requirements

- Astro 6 or 7
- Node 22.12.0+
- **Static delivery:** default Astro static output (no adapter)
- **Server delivery:** `output: 'server'` plus an SSR adapter

## Browser development

`npm run typecheck:browser` checks the extracted Studio modules with strict
JavaScript types. It also runs as part of core type checking and the standard
check gate. See [browser maintenance](../../docs/browser-maintenance.md) for
module boundaries, asset delivery, and the remaining incremental work.

## License

MIT
