/**
 * JSON Schemas handed to caret() so the Studio (/admin/cms) shows friendly field
 * labels and the right input per field instead of inferring from stored values.
 * Keys match the collection names; `title` becomes the field label in the editor.
 *
 * NOTE: `blog` is NOT here — it's derived from its Zod schema (src/schemas.mjs)
 * in astro.config via @caretcms/zod, so it stays a single source of truth shared
 * with content.config.ts. The collections below have no Zod counterpart.
 */

/** @type {Record<string, Record<string, unknown>>} */
export const schemas = {
  site: {
    type: "object",
    title: "Site settings",
    properties: {
      brand: { type: "string", title: "Brand name", minLength: 1 },
      tagline: { type: "string", title: "Tagline", minLength: 1 },
      nav_work: { type: "string", title: "Nav · Work label" },
      nav_blog: { type: "string", title: "Nav · Blog label" },
      nav_about: { type: "string", title: "Nav · About label" },
      footer_note: { type: "string", title: "Footer note" },
      footer_email: { type: "string", title: "Contact email", format: "email" },
    },
    required: ["brand", "tagline", "footer_email"],
  },
  pages: {
    type: "object",
    title: "Page",
    properties: {
      eyebrow: { type: "string", title: "Eyebrow" },
      headline: { type: "string", title: "Headline" },
      intro: { type: "string", title: "Intro (rich)", format: "html" },
      cover: { type: "string", title: "Cover image", format: "image" },
      cover_alt: { type: "string", title: "Cover alt text" },
      section_marker: { type: "string", title: "Section marker" },
      section_title: { type: "string", title: "Section title" },
      section_body: { type: "string", title: "Section body (rich)", format: "html" },
      cta_label: { type: "string", title: "CTA label" },
      cta_href: { type: "string", title: "CTA link", format: "uri" },
    },
  },
  gallery: {
    type: "object",
    title: "Gallery image",
    properties: {
      src: { type: "string", title: "Image", format: "image", default: "/gallery/01.svg" },
      alt: { type: "string", title: "Alt text", default: "Describe this image" },
      caption: { type: "string", title: "Caption", default: "Untitled project" },
      year: { type: "string", title: "Year", pattern: "^[0-9]{4}$", default: "2026" },
    },
    required: ["src", "alt", "caption", "year"],
  },
  team: {
    type: "object",
    title: "Team member",
    properties: {
      name: { type: "string", title: "Name", default: "New team member" },
      role: { type: "string", title: "Role", default: "Role" },
      bio: { type: "string", title: "Bio (rich)", format: "html", default: "" },
      avatar: { type: "string", title: "Avatar", format: "image", default: "/gallery/01.svg" },
    },
    required: ["name", "role", "bio", "avatar"],
  },
};
