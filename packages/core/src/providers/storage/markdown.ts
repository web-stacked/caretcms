import { MarkdownAdapter } from "../../runtime/storage/markdown-adapter.js";

export function markdownStorageProvider(options?: {
  contentRoot?: string;
  metaRoot?: string;
  /** Where the content config's `file()` paths resolve from; the integration sets it. */
  projectRoot?: string;
}): MarkdownAdapter {
  return new MarkdownAdapter(options);
}

export default markdownStorageProvider;
