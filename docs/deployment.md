# Deployment & storage topology

Content location is a swappable detail (see [design-principles.md](./design-principles.md)
§3). Pick the storage adapter that fits how your content is authored and how often
it changes — the rest of CaretCMS works the same either way.

## Delivery mode

| Mode | Astro output | Production shape | When edits reach visitors |
|---|---|---|---|
| **Static delivery** | `static` (default) | CDN/static host, no CMS routes in prod | After Publish + `astro build` + deploy |
| **Server delivery** | `server` + adapter | Node / Workers / etc. with live CMS routes | Immediately (middleware rewrite) |

Static delivery guide: [static-delivery.md](./static-delivery.md).

## The matrix

| | **Filesystem + git** (editorial) | **Cloudflare KV/R2** (edge / high-write) |
|---|---|---|
| Adapter | `markdownStorage` / `filesystemStorage` | `cloudflareStorage` + `r2Uploads` |
| Content lives in | the repo (`src/content/*.md`, `.caret/data`) | KV namespace + R2 bucket |
| Static delivery | ✅ bake at build from same storage | ✅ bake at build from KV |
| Also powers `getCollection()` | ✅ same `.md` files (markdown adapter) | — |
| History / audit | **git** (commit-on-publish) + sidecar | sidecar revisions only |
| Drafts overlay | `.caret/drafts/<editorId>/` (JSON) | `draft/<editorId>/` KV prefix |
| Demo sandbox overlay | — | `session/<id>/` KV prefix, 2h TTL |
| Hosting | static CDN, or Node if using server delivery | Cloudflare Workers — no CMS to run |
| Best for | docs sites, blogs, marketing — content reviewed like code | apps with frequent, programmatic, or high-volume writes |
| Gives up | needs a writable disk; single-writer (embedded) | no git history of content edits |

## Filesystem + git (the "repo is the CMS" path)

```js
// astro.config.mjs
caret({
  storage: markdownStorage({ contentRoot: "./src/content" }),
  uploads: localUploads({ uploadsDir: "./public/uploads" }),
})
```

- The **same markdown files** serve `getCollection()` at build time and inline
  editing at runtime — edits write back to frontmatter.
- Opt into **commit-on-publish** so a publish becomes a git commit authored by the
  editor (blame, revert, content PRs):
  ```bash
  CARET_GIT_ON_PUBLISH=true
  ```
  Best-effort and scoped to the content dir; a git failure never blocks the publish.
- **Drafts** land under `.caret/drafts/<editorId>/` — add `.caret/` to `.gitignore`
  so unpublished drafts never get committed; only a Publish writes to tracked files.

## Cloudflare KV/R2 (edge path)

```js
caret({
  storage: cloudflareStorage({ binding: "CMS_KV" }),
  uploads: r2Uploads({ binding: "CMS_R2" }),
})
```

- No server and no disk: content is KV/R2, the site runs on Workers.
- Per-editor drafts use a `draft/<editorId>/` key prefix (no TTL); the demo
  sandbox overlay uses `session/<id>/` with a 2-hour TTL.
- `CARET_GIT_ON_PUBLISH` is a no-op here (nothing to commit) — history is the
  sidecar revision log.

## Cross-cutting runtime switches

| Env / signal | Effect |
|---|---|
| `CARET_EDIT_PASSWORD` | the editor login password (required to sign in) |
| `CARET_SESSION_SECRET` | HMAC secret for session cookies (**required in production**) |
| `CARET_GIT_ON_PUBLISH=true` | commit published content to git (filesystem + git repo only) |
| `CARET_DEMO_MODE=true` | per-visitor sandbox overlays (needs an adapter with `makeSessionOverlay`) |
| `caret_preview` cookie | per-editor **draft preview**: read/write the draft overlay; toggled by the editor toolbar's Preview button |
| `caret({ delivery: { publish: { webhookUrl }}})` | POST/PUT rebuild hook after publish (static delivery CI) |

## Drafts → publish, in one line

Regardless of backend: **Preview** mounts the editor's overlay (edits stay
unpublished), **Publish** flushes the overlay into the base and returns the new
revisions (and, on the git path, a commit), **Discard** drops the overlay. The
overlay mechanism (`makeEditorOverlay`) is per-adapter; the workflow is identical.
