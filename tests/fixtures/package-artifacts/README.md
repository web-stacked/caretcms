# Installed npm package checks

Run `npm run test:packages` from the root. The command cleans and builds all four published
packages, packs their actual distributions, and installs them in a temporary
consumer outside the monorepo. The consumer has pinned Astro, TypeScript, Zod,
and Node types; CaretCMS resolves exclusively to the installed tarballs.

The gate checks every exported JavaScript/declaration target, license/README
inclusion, forbidden source/test/private-storage payloads, and the core/Caretize
dependency boundary. A strict NodeNext consumer imports all 20 entrypoints and
uses types across the packages. Like the repository, it skips dependency library
body checking; this is a consumer contract check, not a complete declaration lint.

Actual execution covers filesystem storage through the public conformance
export, Caretize parsing/planning and the installed executable with core removed
from module resolution, Zod conversion,
and bundling the published browser/editor JS and CSS. The installed Cloudflare
package and public Durable Object class run in native workerd with local KV,
SQLite, and R2. It tests KV and both Durable Object draft modes with public
conformance, then compares uploaded PNG bytes and MIME metadata in R2. Optional
capabilities produce explicit skips, not inferred passes.

The standalone Worker uses `nodejs_compat` with compatibility date 2026-01-01,
an empty bundled-content map, and empty unused Astro virtual modules. Real Astro
virtual-provider/schema injection is covered separately by the application SSR
and packed-core consumer gates. The date applies only to this test; application
defaults remain unchanged. Nothing is deployed or published, and temporary
packages, secrets, and native storage are deleted afterward.

GitHub's existing Node matrix runs the gate after all package builds. It needs
network access for pinned consumer dependencies, but no account credentials.
