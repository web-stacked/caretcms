# Content Site Example — Atlas & Co.

A robust, multi-page editorial site that exercises the **full CaretCMS surface**
on the Node adapter. Everything you see is a real `.md` file under
`src/content/`, edited in place and written straight back to disk.

## What it demonstrates

| Capability | Where |
| --- | --- |
| **Astro content collections** (build-time, `getCollection` + `render()` for markdown bodies) | `blog` — `src/content.config.ts`, `src/pages/blog/` |
| **Caret live collections** (per-request, stega-encoded for editors) | `site` / `pages` / `gallery` / `team` — `src/live.config.ts` |
| **Unified markdown storage** (one source of truth: edits write back to frontmatter) | `markdownStorage({ contentRoot: "./src/content" })` in `astro.config.mjs` |
| **Scoped inline editing** (`data-caret-scope` + `data-caret`) | every page |
| **Rich text** (`data-caret-rich` + `set:html`, sanitizer-allowlisted classes) | hero/section/bio fields |
| **Repeating items** (`bindEntry` over a collection) | gallery grid, team grid, blog cards |
| **Editable component props** (a child renders the prop as text) | `src/components/PostCard.astro` |
| **Image uploads** (`<img data-caret>` → `localUploads`) | hero cover, gallery, avatars, post covers |
| **Per-collection schemas** (Studio field labels/types) | `src/caret.schemas.mjs` |
| **`caretize`** (auto-tag the `.astro` that isn't bound yet) | `npm run caretize` |

> **Why Node, not Cloudflare?** `markdownStorage` needs a filesystem, so the
> markdown-backed content-collection story runs on `@astrojs/node`. The Cloudflare
> `demo` example covers KV/R2 storage instead.

## The two collection systems, side by side

- **`blog`** is a normal **Astro content collection** (glob loader + Zod schema).
  Its markdown *body* renders via `render()`; its *frontmatter* (title, excerpt,
  …) is caret-editable because the same files back `markdownStorage`. Edit a
  title inline → it's written to the post's frontmatter → Astro re-renders.
- **`site` / `pages` / `gallery` / `team`** are **caret live collections**
  (`caretLoader`). They're queried with `getLiveEntry` / `getLiveCollection` and,
  for an authenticated editor, every string is stega-encoded so it's click-to-edit
  even without a `data-caret` attribute.

> The blog schema uses `z.coerce.date()` on purpose: after an inline edit, caret's
> frontmatter codec re-emits `date: 2026-05-18` unquoted, which Astro's YAML reads
> as a `Date`. `coerce` accepts both the authored string and the post-edit Date.

## Run

```sh
npm install
CARET_EDIT_PASSWORD=devpass npm run dev -w @caretcms/example-content-site
```

(Or just `npm run dev` — without a password set, dev prints a temporary one.)

- `/` — homepage: hero (rich intro + cover upload), gallery, latest journal
- `/about` — studio page + team grid
- `/blog` and `/blog/<slug>` — the content-collection journal
- `/admin` — login (password: `devpass`)
- `/admin/cms` — the Studio: browse and edit every collection

Sign in, then click any line to edit it. Saves land in `src/content/**.md`.

## caretize

`src/content/*` is hand-bound for the showcase, but the `.astro` files still
have a few un-tagged headings. See what the auto-tagger would do:

```sh
npm run caretize        # caretize src --dry-run
```
