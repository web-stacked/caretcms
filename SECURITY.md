# Security Policy

CaretCMS handles authentication cookies, HTML rewriting and sanitization, file uploads, and source-file writes. We take security reports seriously.

## Supported Versions

Security fixes are applied to the latest minor release line of `@caretcms/*`:

| Version | Supported |
| ------- | --------- |
| `0.7.x` | Yes |
| `< 0.7` | No (upgrade to latest `0.7.x`) |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via [GitHub Security Advisories](https://github.com/web-stacked/caretcms/security/advisories/new).

Please include:
- Affected package(s) and version(s)
- Delivery/storage configuration (static vs. server, Node vs. Cloudflare, auth mode)
- Steps to reproduce or a minimal proof of concept
- Expected impact

## Response Expectations

- We aim to acknowledge reports within **72 hours**.
- Once confirmed, we will work on a fix and regression test, coordinate a release, and credit you in the advisory/changelog if you wish.

## Areas of Particular Interest

- Authentication, session signing/verification, and authorization policy bypasses
- XSS or attribute injection in HTML rewriting (`rewrite.ts`) or rich-text/Markdown sanitization
- Path traversal or unauthorized writes in storage adapters, Git journaling, or uploads
- Cross-editor draft leakage or privilege escalation
