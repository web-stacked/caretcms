# CaretCMS on Cloudflare

A complete example of running CaretCMS on Cloudflare Workers, with content in
**KV** and image uploads in **R2**. Use it as the reference for an edge
deployment of your own site.

## What it shows

- `@astrojs/cloudflare` adapter with `output: "server"`
- `cloudflareStorage({ binding: "CMS_KV" })` — content entries in Workers KV
- `r2Uploads({ binding: "CMS_R2" })` — uploaded images in R2
- Single-password editor auth via `CARET_EDIT_PASSWORD`

Seed content lives in `.caret/data/**` (the "Studio Norra" sample site).

## One-time Cloudflare setup

```sh
# 1. Create the KV namespace, then paste its id into wrangler.toml
wrangler kv namespace create CMS_KV

# 2. Create the R2 bucket (matches bucket_name in wrangler.toml)
wrangler r2 bucket create caret-uploads

# 3. Set the editor password as a secret
wrangler secret put CARET_EDIT_PASSWORD
```

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

Visit `/admin` to log in with `CARET_EDIT_PASSWORD`, then edit any page inline.
