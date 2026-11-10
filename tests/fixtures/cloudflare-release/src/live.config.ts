import { defineLiveCollection } from "astro:content";
import { caretLoader } from "@caretcms/core/loader";
export const collections = { pages: defineLiveCollection({ loader: caretLoader("pages") }) };
