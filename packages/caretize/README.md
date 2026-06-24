# @caretcms/caretize

Make an existing Astro site editable with [CaretCMS](https://github.com/web-stacked/caretcms): `caretize` scans your `.astro` templates and inserts `data-caret` attributes (plus `editable()` wraps for data arrays), turning static markup into inline-editable content — no schema or config rewrite required.

The static HTML you already have *is* the seed content: CaretCMS renders the original text until an editor saves an override, so caretize only has to mark what's editable.

```sh
# in your Astro project root — set CaretCMS up first (deps + astro.config + .env)
npx @caretcms/caretize init

# preview what would be tagged, write nothing
npx @caretcms/caretize --dry-run
npx @caretcms/caretize --diff

# default: apply safe edits, show a diff you can --restore
npx @caretcms/caretize

# approve each change before writing
npx @caretcms/caretize --review
```

`init` is optional but is the fastest path on a project that hasn't wired
CaretCMS yet: it installs `@caretcms/core`, wires `caret()` into `astro.config`, and
scaffolds a `.env` with a generated `CARET_SESSION_SECRET`.

- **Static Astro projects** (default): `caret({ delivery: "static" })` — no SSR adapter.
- **Server projects** (`output: "server"` already): keeps or adds adapter + `caret()`.

An existing config is only edited via verified pure insertions (shown as a diff you
confirm, backed up first); when its shape isn't safe to touch automatically it prints
a snippet to paste instead.

## What it does

By default caretize **optimistically applies** high-confidence candidates, then shows a before→after diff. Use `--review` to approve each binding interactively:

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

- **Nothing unsafe is written.** Every output is verified in memory first: it must re-parse as valid Astro and be a pure insertion of the original (your bytes survive untouched, in order).
- **All-or-nothing:** if any file fails verification, the run aborts having written nothing.
- **Backups:** every written file is first copied to `.caret/.caretize-bak/`; `caretize --restore` reverts the most recent run. Git is the real undo — caretize warns when your tree is dirty.
- Multibyte-safe: offsets are computed and spliced on UTF-8 buffers (emoji/em-dashes can't corrupt a tag).

## Options

```
caretize [path] [options]
caretize init                wire CaretCMS into the project, then tag

  init                     set up CaretCMS first: install @caretcms/core, wire
                           caret() into astro.config (static delivery by default;
                           server projects get SSR adapter wiring), scaffold .env
  path                     file or directory to scan (default: src/)
  --review                 approve each change before writing; richer tiers still
                           offered at the end
  --dry-run                print the plan, write nothing
  --diff                   preview exact before→after, write nothing
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
  --rich-class             also tag rich blocks whose inline children carry a
                           class — implies --rich; class round-trips once blessed
                           via caret({ allowedClasses }) (hint names which)
  --all                    every opt-in tier at once: --bind-collections,
                           --bind-routes, --rich, --rich-class, AND
                           --min-confidence low
  --scope <collection::id> override the inferred scope (validated against the
                           runtime grammar: ^[a-z][a-z0-9_-]*$ :: ^[a-z0-9][a-z0-9_-]*$)
  --report <file>          write a JSON report
  --restore                restore the most recent backup, then exit
```

## After caretize

1. `npm run dev`
2. Sign in at `/admin` — with no `CARET_EDIT_PASSWORD` set, a temporary dev password is printed in your terminal
3. Click any tagged element to edit it in place; the Studio lives at `/admin/cms`
4. Use Preview / Publish / Discard in the editor toolbar for draft workflow

Requires [`@caretcms/core`](https://www.npmjs.com/package/@caretcms/core) wired into `astro.config.mjs` (caretize's preflight checks this and tells you if it isn't).

**Static Astro sites:** use `caret({ delivery: "static" })` (caretize `init` does this by default). Edit locally in dev; after Publish, rebuild so CaretCMS bakes stored content into static HTML. See [static delivery docs](https://github.com/web-stacked/caretcms/blob/main/docs/static-delivery.md).

**Server sites:** use `output: "server"` with an SSR adapter and `caret()` for per-request rewriting in production.

MIT © CaretCMS contributors
