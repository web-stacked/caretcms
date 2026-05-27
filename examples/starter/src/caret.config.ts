import { defineLiveCollection } from "astro:content";
import { caretLoader } from "@caretcms/core";

const pages = defineLiveCollection({
  loader: caretLoader("pages"),
});

export const collections = { pages };
