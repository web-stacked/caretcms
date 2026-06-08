import { MarkdownAdapter } from "../../runtime/storage/markdown-adapter.js";

export function markdownStorageProvider(options?: {
  contentRoot?: string;
  metaRoot?: string;
}): MarkdownAdapter {
  return new MarkdownAdapter(options);
}

export default markdownStorageProvider;
