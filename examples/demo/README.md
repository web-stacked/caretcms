# CaretCMS on Cloudflare (public sandbox)

The public "try it" sandbox running on Cloudflare Workers, with content in
**KV** and image uploads in **R2**. It runs in [demo mode](https://caretcms.com/docs/demo-mode/):
every visitor edits in a private, 2-hour session with no password, and the
canonical content is never touched.

> Building your own site? Start from `examples/starter` or `examples/content-site`
> instead — those are the password-protected references. This one is wired as an
> open sandbox on purpose.

## What it shows

- `@astrojs/cloudflare` adapter with `output: "server"`
- `cloudflareStorage({ binding: "CMS_KV" })` — content entries in Workers KV
- `r2Uploads({ binding: "CMS_R2" })` — uploaded images in R2
- `CARET_DEMO_MODE = "true"` — per-visitor sandbox sessions (no editor password)

Seed content lives in `.caret/data/**` (the "Studio Norra" sample site); it's the
snapshot every visitor's session starts from.

## One-time Cloudflare setup

```sh
# 1. Create the KV namespace, then paste its id into wrangler.toml
wrangler kv namespace create CMS_KV

# 2. Create the R2 bucket (matches bucket_name in wrangler.toml)
wrangler r2 bucket create caret-uploads

# 3. Enable an R2 custom domain or r2.dev access, then store its hostname
wrangler secret put R2_PUBLIC_DOMAIN
```

Demo mode needs no editor password — `CARET_DEMO_MODE` is set in `wrangler.toml`
under `[vars]`. (Set `CARET_SESSION_SECRET` as a secret if you want signed cookies.)

## Deploy

```sh
npm install
npm run deploy
```

Then map a custom domain to the Worker via the Cloudflare dashboard.

## Local dev

```sh
npm run dev       # plain Astro dev server
npm run preview   # runs against Wrangler with the KV/R2 bindings
```

Open the site and click any line to edit it — no login. Each browser gets its own
isolated session. Visit `/admin/cms` to see the entries behind the page.
