/**
 * Loaded into every page's server code (`injectScript("page-ssr")`): it loads
 * the providers module, which registers the configured storage, so pages
 * built without a request (static builds) can read published values.
 */
import "./providers.js";
