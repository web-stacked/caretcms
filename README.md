# CaretCMS

CaretCMS is a reusable, open-core CMS for Astro 6 and 7. Add one HTML attribute — or point it at existing `.md` / `.json` content collections — to get inline page editing, a content Studio, and multi-editor draft workflows with zero SaaS lock-in.

### What it does

**Inline & Studio editing**
- **Inline canvas editing** — edit text, rich text, images, Markdown prose (`data-caret-md`), and section layout directly on the live page
- **Attribute-first & collection-aware** — use `data-caret` attributes on static markup, or edit `astro:content` Markdown (including sub-folders like `en/post-1.md`) and JSON `file()` collections in place
- **Content Studio** — structured forms inferred from Astro/Zod schemas (enums, plain dates, `reference()` fields, galleries), opened as a drawer right over the site
- **Live content collections** — native `astro:content` live loaders via `caretLoader()`

**Editing together safely**
- **On-page Changes view** — amber dots for your drafts, blue dots for teammate/developer edits made under you, and amber+blue rings for same-value conflicts, with word-diff cards and single-field undo
- **Nested-object merging** — two people editing different keys in the same section (`hero.headline` and `hero.subtext`) merge automatically without colliding
- **Selective Publish & guarded Undo** — tick which drafts to ship, keep works-in-progress as drafts, and undo a publish for 30 minutes as a new forward commit (Git history is never rewritten)
- **Page history & While-away tour** — scrub a timeline slider right on the page (fields, images, rich text, and Markdown body text) and step through changes made since your last visit
- **Minimal source diffs** — writes back to Markdown and JSON while keeping compact YAML lists, single-line JSON entries, and straight quotes intact

**Delivery, storage & zero lock-in**
- **Static or server delivery** — keep `output: 'static'` (build-time HTML bake + rebuild webhook) or run `output: 'server'` (per-request rewriting)
- **Pluggable storage & auth** — Markdown/JSON or filesystem by default, coordinated Cloudflare Durable Objects / KV / R2 via `@caretcms/cloudflare`, optional identity/role policies, and verified deployment status providers
- **Clean CLI lifecycle** — `caretize init` wires an existing site, `caretize doctor` audits drafts/Git/uploads, and `caretize remove` strips CaretCMS cleanly while keeping your work

The CMS ships as `@caretcms/core`, an Astro integration you install into any Astro app. See [docs/README.md](docs/README.md) for the full documentation map.

![CaretCMS on a small shop's site: type a new headline, drag in a new photo, change a price and undo it, then edit a product and a workshop in the Studio while the page updates beside it](https://caretcms.com/preview/caretcms-demo.gif)

## Packages

| Package | Description |
|---------|-------------|
| [`@caretcms/core`](packages/core) | Platform-neutral core: integration, mutation engine, studio admin, inline editor, `StorageAdapter` interface |
| [`@caretcms/cloudflare`](packages/cloudflare) | Cloudflare storage + upload adapters (Durable Objects, KV, and R2) |
| [`@caretcms/caretize`](packages/caretize) | CLI that scans an existing Astro site and adds `data-caret` attributes interactively |
| [`@caretcms/zod`](packages/zod) | Optional Zod → JSON Schema bridge for `caret({ schemas })` |

## Examples

| Example | What it shows |
|---------|---------------|
| [`examples/starter`](examples/starter) | Smallest useful CMS-enabled Astro site |
| [`examples/content-site`](examples/content-site) | Editorial content site with scoped bindings and shared content |
| [`examples/demo`](examples/demo) | Cloudflare deployment example |

## Quick start

For an existing Astro site, the lowest-friction path is the CLI:

```sh
npx @caretcms/caretize init
npx @caretcms/caretize
npm run dev
```

Then sign in at `/admin` and click tagged content to edit. Static Astro projects
keep static output automatically; server projects keep server output.

Prefer to wire it by hand? Pick the delivery shape that matches your Astro output:

### Static sites (recommended for marketing / brochure sites)

No SSR adapter. Author locally; public visitors see edits after **Publish → rebuild → deploy**.

```sh
npm install @caretcms/core
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import caret from '@caretcms/core';

export default defineConfig({
  // Astro defaults to output: 'static'; caret() auto-selects static delivery.
  integrations: [caret()],
});
```

`caret()` uses automatic delivery by default: static Astro output bakes content at
build time, while server output uses middleware.

See [docs/static-delivery.md](docs/static-delivery.md) for the full publish/rebuild flow.

### Server-rendered sites (instant visitor updates)

Per-request HTML rewriting in production. Requires `output: 'server'` and an SSR adapter:

```sh
npm install @caretcms/core @astrojs/node
```

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

### After wiring either path

- Add `data-caret` / `data-caret-scope` attributes, or run `npx @caretcms/caretize` to tag an existing site interactively
- Run `npm run dev`. With no password configured, dev uses a temporary password kept in `.caret/dev-password` (also shown by `astro dev logs`)
- **Sign in at `/admin`**, then click tagged content to edit; the toolbar's **Studio** button opens the content Studio over the page
- For production authoring, set `CARET_EDIT_PASSWORD` and `CARET_SESSION_SECRET` (see [deployment](docs/deployment.md))
- Optionally create `src/caret.config.ts` with `caretLoader` for `getLiveEntry` / `getLiveCollection`

The inline editor bootstraps when a `data-caret` or `data-caret-md` binding is
present **and** `/api/cms/auth/session` confirms an authenticated session.
Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.

Full API reference: [`packages/core/README.md`](packages/core/README.md). Static delivery guide: [docs/static-delivery.md](docs/static-delivery.md). Docs site: **https://caretcms.com/docs**.

### Upgrading, checking and removing

- **Upgrading:** read the [changelog](CHANGELOG.md) for the version you're moving to before you upgrade a site people are editing. Releases that change stored content or URLs say so and link their upgrade steps.
- **Checking a site:** `npx @caretcms/caretize doctor` reports unpublished drafts, content Git hasn't committed, unused uploads and `.gitignore` mistakes. It changes nothing.
- **Removing CaretCMS:** `npx @caretcms/caretize remove` takes the attributes and the integration out and keeps the rest of your work.

## Develop in this repo

```sh
npm install

# run the example apps
npm run dev:starter      # minimal "ship fast" path
npm run dev:content      # integrate into a real template

# core package checks
npm run typecheck:core
npm run build:core
```

## Quality gates

```sh
npm run validate:versions   # pinned-version policy
npm run typecheck:core
npm run build:core
npm run test:unit
npm run test:e2e            # builds core, runs the starter, drives the editor
```

Or run the full gate with `npm run check`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
