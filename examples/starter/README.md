# Starter Example

Minimal greenfield starter that consumes `@caretcms/core` from the workspace.

Use this example when you want to understand the smallest useful CaretCMS setup:

- one editable landing page
- one collection scope
- one obvious inline editing path
- Astro live content collections via `src/caret.config.ts` (Astro 6 stable, Astro 5.10+ experimental)
- the admin, theme, schema, and mutation routes wired up end to end

This example exists as both a starter baseline for users and a lightweight integration fixture for the package.

The `src/caret.config.ts` file wires the `pages` and `themes` collections into Astro's content layer using `caretLoader`. Pages can use `getLiveEntry('pages', 'home')` from `astro:content` alongside `data-caret` inline editing.

Run:

```sh
npm install
CARET_EDIT_PASSWORD=devpass npm run dev -w @caretcms/example-starter
```

Try:

- `/admin`
- `/api/cms/entries?collection=pages&page=1&pageSize=10`
- `/api/cms/schema?collection=pages`
- `POST /api/cms/mutate` (example body below)

```json
{
  "type": "save_field",
  "collection": "pages",
  "id": "home",
  "field": "hero.headline",
  "value": "Updated from mutate API"
}
```
