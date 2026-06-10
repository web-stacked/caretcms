# Vendored test fixtures

These `.astro` files are unmodified copies of official examples from the
[`withastro/astro`](https://github.com/withastro/astro/tree/main/examples)
repository, used here only as a real-world corpus for `caretize` tests.

They are MIT-licensed (© Astro contributors). Source (under `examples/`):

| fixture | source |
| --- | --- |
| `blog-index.astro` | `blog/src/pages/index.astro` |
| `blog-header.astro` | `blog/src/components/Header.astro` |
| `portfolio-index.astro` | `portfolio/src/pages/index.astro` |
| `portfolio-nav.astro` | `portfolio/src/components/Nav.astro` |
| `portfolio-hero.astro` | `portfolio/src/components/Hero.astro` |
| `starlog-index.astro` | `starlog/src/pages/index.astro` |
| `basics-index.astro` | `basics/src/pages/index.astro` |
| `framework-react-index.astro` | `framework-react/src/pages/index.astro` |
| `hackernews-nav.astro` | `hackernews/src/components/Nav.astro` |

The spread is deliberate: static-content pages, dynamic/prop-driven components
(0 candidates — proves invariants hold with no tags), `.map()`-heavy navs (loop
flagging), and framework-island pages.
