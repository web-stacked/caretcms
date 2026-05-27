import { defineLiveCollection } from "astro:content";
import { caretLoader } from "@caretcms/core";

const pages = defineLiveCollection({
  loader: caretLoader("pages"),
});

const site = defineLiveCollection({
  loader: caretLoader("site"),
});

export const collections = { pages, site };
