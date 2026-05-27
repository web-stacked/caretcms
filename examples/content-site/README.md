# Content Site Example

Minimal content-site example with `@caretcms/core` integrated.

Use this example when you want to see CaretCMS in a more realistic template-style setup:

- shared site content in one scope (`site::global`)
- page content in another scope (`pages::home`)
- editable content that still reads like normal Astro markup
- Astro live content collections via `src/caret.config.ts` (Astro 6 stable, Astro 5.10+ experimental)

This is the better baseline when a user is starting from an existing marketing site or editorial template instead of a blank page.

The `src/caret.config.ts` file wires `pages` and `site` collections into Astro's content layer using `caretLoader`. Pages can query data with `getLiveEntry` / `getLiveCollection` from `astro:content` alongside inline editing.

## Run

```sh
npm install
CARET_EDIT_PASSWORD=devpass npm run dev -w @caretcms/example-content-site
```

## What you get

- `/` — Content-focused homepage with inline-editable title, intro, and site name
- `/admin` — Login page (password: `devpass`)
- `/admin/cms` — Content Studio (browse/edit all seed collections)

Once logged in, click any text on the homepage to edit it in place.
