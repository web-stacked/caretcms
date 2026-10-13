# Packed consumer compatibility

Run `npm run build:core`, then `npm run test:compat -- 6.0.0` to check the
declared peer lower bound. `npm run test:compat` (or `-- pinned`) checks the
exact Astro version in the root manifest. CI runs both with Node 22.12.0 and 24.

The script packs core, copies this fixture into an OS temporary directory,
installs that tarball and the selected Astro version, and starts a local server
through Astro's API. It checks live collection loading, password authentication,
private caching, schema rejection, optimistic concurrency, draft publication,
and the shipped editor/Studio assets. A static production build must bake the
approved bytes and omit authoring APIs. A separate production build uses the Node
standalone adapter and starts its emitted server entrypoint in a child process.
It checks live loads, private preview isolation, validation, stale-save conflicts,
publication without rebuilding, shipped assets, and persistence after a process
restart. Production authentication uses a random runtime session secret.
The Astro 6.0.0 consumer pins Node adapter 10.0.2, whose imports match that lower
bound; the Astro 7 consumer uses the starter's exact adapter pin.
The server is stopped and temporary
files are removed on completion or failure. The repository's dependency pins,
lockfile, example content, and workspace adapters are not modified.

Install access to the npm registry is required. These are HTTP/package smoke
tests; browser interactions remain covered by the separate Playwright suites.
