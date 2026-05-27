import { FilesystemAdapter } from "../../runtime/storage/filesystem-adapter.js";

export function filesystemStorageProvider(options?: {
  dataRoot?: string;
  metaRoot?: string;
}): FilesystemAdapter {
  return new FilesystemAdapter(options);
}

export default filesystemStorageProvider;
