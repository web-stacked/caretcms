# @caretcms/zod

Derive [CaretCMS](https://github.com/web-stacked/caretcms) Studio schemas from the Zod schemas you already have.

CaretCMS's Studio consumes plain JSON Schema, and `@caretcms/core` stays deliberately Zod-agnostic (zero runtime deps). If you already describe a content collection with Zod — e.g. in Astro's `content.config.ts` — this helper turns that one source into the JSON-Schema map you hand to `caret({ schemas })`, so field definitions, labels, and widget hints live in a single place.

```sh
npm install @caretcms/zod zod
```

```js
// astro.config.mjs
import caret from '@caretcms/core';
import { schemasFromZod } from '@caretcms/zod';
import { blogSchema, pageSchema } from './src/schemas.mjs';

export default defineConfig({
  integrations: [
    caret({ schemas: schemasFromZod({ blog: blogSchema, page: pageSchema }) }),
  ],
});
```

What the conversion does beyond `z.toJSONSchema`:

- **Dates** (`z.date()` / `z.coerce.date()`) become `{ type: "string", format: "date" }` so the Studio renders a date widget.
- **`description` → `title`**: Zod `.describe("Headline")` becomes the field's Studio label (an explicit `title` wins; `description` is kept).
- **`override` hook** for per-node tweaks: `schemaFromZod(schema, { override: ({ jsonSchema }) => { … } })`.

API: `schemaFromZod(zodObjectSchema, options?)` for one collection, `schemasFromZod({ name: schema, … }, options?)` for the whole map.

Requires Zod v4 (peer dependency, uses `z.toJSONSchema`). Nothing here is imported by `@caretcms/core` — its Zod-agnostic boundary stays intact.

MIT © CaretCMS contributors
