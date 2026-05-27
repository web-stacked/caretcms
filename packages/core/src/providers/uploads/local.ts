import { FilesystemUploadHandler } from "../../runtime/storage/filesystem-upload-handler.js";

export function localUploadsProvider(options?: {
  uploadsDir?: string;
}): FilesystemUploadHandler {
  return new FilesystemUploadHandler(options);
}

export default localUploadsProvider;
