# @caretcms/caretize

Make an existing Astro site editable with [CaretCMS](https://github.com/web-stacked/caretcms): `caretize` scans your `.astro` templates and interactively inserts `data-caret` attributes (plus `editable()` wraps for data arrays), turning static markup into inline-editable content — no schema or config rewrite required.

The static HTML you already have *is* the seed content: CaretCMS renders the original text until an editor saves an override, so caretize only has to mark what's editable.

```sh
# in your Astro project root — preview first, write nothing
npx @caretcms/caretize --dry-run

# then run the interactive review
npx @caretcms/caretize
```

## What it does

For every candidate it finds, caretize shows the element and proposed binding and asks:

```
src/pages/index.astro
  <h1> "Launch faster with Acme"
  + data-caret="pages::home::launch_faster_with_acme"  (high)
  [a]ccept [s]kip [e]dit [A]ll [S]kip-file [q]uit >
```

- **Tags** pure-text leaf elements (`h1`–`h6`, `p`, `li`, `a`, `button`, …) and `<img>` `src` — exactly the set the CaretCMS rewrite engine can render, nothing more.
- **Names fields from content** (`"Our Programs 🎨"` → `our_programs`); prose tags keep role names. Names are deterministic and never collide with existing bindings, so re-runs are idempotent.
- **Wraps data arrays** (`const faqs = [...]` → `editable("pages::home::faqs", [...])`) so list content is editable too.
- **Flags what it can't tag** (loops, expressions, mixed markup) and tells you which flag unlocks each.

## Safety model

- **Nothing is written until the review ends.** Every output is verified in memory first: it must re-parse as valid Astro and be a pure insertion of the original (your bytes survive untouched, in order).
- **All-or-nothing:** if any file fails verification, the run aborts having written nothing.
- **Backups:** every written file is first copied to `.caret/.caretize-bak/`; `caretize --restore` reverts the most recent run. Git is the real undo — caretize warns when your tree is dirty.
- Multibyte-safe: offsets are computed and spliced on UTF-8 buffers (emoji/em-dashes can't corrupt a tag).

## Options

```
caretize [path] [options]

  path                     file or directory to scan (default: src/)
  --dry-run                print the plan, write nothing
  -y, --yes                auto-accept all suggestions at/above min-confidence
  --min-confidence <lvl>   high (default) | medium | low
  --no-images              skip <img> elements
  --no-props               skip hoisting static component-prop strings to editable()
  --bind-collections       bind getCollection().map() loops in place — a leaf
                           element rendering {item.data.field} gets a per-row
                           data-caret (direct-render only; props stay flagged)
  --bind-routes            bind a dynamic collection-detail route ([slug].astro)
                           to its current entry via getStaticPaths props
  --rich                   also tag mixed-content blocks whose markup is
                           sanitizer-safe inline formatting (data-caret-rich)
  --scope <collection::id> override the inferred scope (validated against the
                           runtime grammar: ^[a-z][a-z0-9_-]*$ :: ^[a-z0-9][a-z0-9_-]*$)
  --report <file>          write a JSON report
  --restore                restore the most recent backup, then exit
```

## After caretize

1. `npm run dev`
2. Sign in at `/admin` — with no `CARET_EDIT_PASSWORD` set, a temporary dev password is printed in your terminal
3. Click any tagged element to edit it in place; the Studio lives at `/admin/cms`

Requires [`@caretcms/core`](https://www.npmjs.com/package/@caretcms/core) wired into `astro.config.mjs` (caretize's preflight checks this and tells you if it isn't).

MIT © CaretCMS contributors
