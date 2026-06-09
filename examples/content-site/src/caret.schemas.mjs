/**
 * JSON Schemas handed to caret() so the Studio (/admin/cms) shows friendly field
 * labels and the right input per field instead of inferring from stored values.
 * Keys match the collection names; `title` becomes the field label in the editor.
 */

/** @type {Record<string, Record<string, unknown>>} */
export const schemas = {
  site: {
    type: "object",
    title: "Site settings",
    properties: {
      brand: { type: "string", title: "Brand name" },
      tagline: { type: "string", title: "Tagline" },
      nav_work: { type: "string", title: "Nav · Work label" },
      nav_blog: { type: "string", title: "Nav · Blog label" },
      nav_about: { type: "string", title: "Nav · About label" },
      footer_note: { type: "string", title: "Footer note" },
      footer_email: { type: "string", title: "Contact email" },
    },
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
      cta_href: { type: "string", title: "CTA link" },
    },
  },
  blog: {
    type: "object",
    title: "Blog post",
    properties: {
      title: { type: "string", title: "Title" },
      excerpt: { type: "string", title: "Excerpt" },
      date: { type: "string", title: "Date", format: "date" },
      author: { type: "string", title: "Author" },
      tags: { type: "array", title: "Tags", items: { type: "string" } },
      cover: { type: "string", title: "Cover image", format: "image" },
      cover_alt: { type: "string", title: "Cover alt text" },
    },
  },
  gallery: {
    type: "object",
    title: "Gallery image",
    properties: {
      src: { type: "string", title: "Image", format: "image" },
      alt: { type: "string", title: "Alt text" },
      caption: { type: "string", title: "Caption" },
      year: { type: "string", title: "Year" },
    },
  },
  team: {
    type: "object",
    title: "Team member",
    properties: {
      name: { type: "string", title: "Name" },
      role: { type: "string", title: "Role" },
      bio: { type: "string", title: "Bio (rich)", format: "html" },
      avatar: { type: "string", title: "Avatar", format: "image" },
    },
  },
};
