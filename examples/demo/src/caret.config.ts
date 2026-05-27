import { defineLiveCollection } from "astro:content";
import { caretLoader } from "@caretcms/core";

const pages = defineLiveCollection({ loader: caretLoader("pages") });
const gallery = defineLiveCollection({ loader: caretLoader("gallery") });
const projects = defineLiveCollection({ loader: caretLoader("projects") });
const site = defineLiveCollection({ loader: caretLoader("site") });

export const collections = { pages, gallery, projects, site };
