import { canPerform } from "../authorization.js";
import type { CaretRuntimeConfig } from "../config.js";
import { getStudioCollections } from "../schema-registry.js";
import type { StorageAdapter } from "../../types.js";
import { humanizeCollection, type StudioNavItem } from "./studio-layout.js";

/**
 * Every Studio collection for the sidebar and the command palette, with the
 * palette's "New …" action for collections the editor may add entries to.
 */
export async function studioNavigation(
  runtime: CaretRuntimeConfig,
  adapter: StorageAdapter,
  selected?: string,
): Promise<StudioNavItem[]> {
  const collections = await getStudioCollections(adapter);
  return Promise.all(collections.map(async ({ name, config }) => {
    const base = `${runtime.mountPath}/cms/${encodeURIComponent(name)}`;
    const label = config.label || humanizeCollection(name);
    const creatable = !config.singletonId && config.creatable !== false && await canPerform("edit", name) && await canPerform("create", name);
    const entryLabel = config.entryLabel?.trim();
    return {
      name,
      icon: config.icon,
      label,
      href: config.singletonId ? `${base}/${encodeURIComponent(config.singletonId)}` : base,
      ...(selected !== undefined ? { selected: name === selected } : {}),
      ...(creatable
        ? { create: { label: `${runtime.messages["collection.newNamed"]} ${entryLabel || runtime.messages["palette.entry"]}`, href: `${base}#new` } }
        : {}),
    };
  }));
}
