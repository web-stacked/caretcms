# Changelog

All notable changes to CaretCMS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions track the publishable `@caretcms/core` package.

## [0.1.0] - 2026-05-26

### Added

- Initial public release of `@caretcms/core` and `@caretcms/cloudflare`.
- Inline canvas editing via `data-caret` attributes — text, images, and
  section layout edited directly on the page.
- Live content collections through `caretLoader` for Astro 6 `getLiveEntry` /
  `getLiveCollection`.
- Content Studio admin for structured entry editing.
- Pluggable storage via the `StorageAdapter` interface — filesystem and
  in-memory adapters built in, Cloudflare KV/R2 adapter in `@caretcms/cloudflare`.
- Editor authentication with `HttpOnly` / `SameSite=Lax` session cookies,
  optimistic-locking conflict handling, and revision history.

[0.1.0]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.0
