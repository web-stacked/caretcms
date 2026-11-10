import { CloudflareDurableStorageAdapter } from "gate:durable-adapter";

export function storage(options: { instanceName: string; editorDrafts: string }) {
  return new CloudflareDurableStorageAdapter(options);
}
export function uploads() {
  return { async upload() { throw new Error("Uploads are disabled in the release-validation fixture"); } };
}
