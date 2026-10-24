import { describe, expect, it } from "vitest";
import { IMAGE_MAX_SIZE, UPLOAD_MESSAGES, readAndValidateImage } from "../../packages/core/src/runtime/storage/image-validation";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

describe("upload refusals are worded for editors", () => {
  it("names the reason and what to use instead", async () => {
    await expect(readAndValidateImage(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })))
      .rejects.toThrow("This file type can't be used. Use a JPEG, PNG, WebP or AVIF image.");
    await expect(readAndValidateImage(new File([new Uint8Array(IMAGE_MAX_SIZE + 1)], "huge.png", { type: "image/png" })))
      .rejects.toThrow("This image is larger than 10 MB. Use a smaller image.");
    await expect(readAndValidateImage(new File(["just text"], "notes.png", { type: "image/png" })))
      .rejects.toThrow(UPLOAD_MESSAGES.contents);
    await expect(readAndValidateImage(new File([PNG], "photo.jpg", { type: "image/jpeg" })))
      .rejects.toThrow(UPLOAD_MESSAGES.contents);
    await expect(readAndValidateImage(new File([PNG], "dot.png", { type: "image/png" }))).resolves.toMatchObject({ kind: "png" });
  });

  it("never mentions MIME types or formats an editor can't act on", () => {
    for (const message of Object.values(UPLOAD_MESSAGES)) expect(message).not.toMatch(/MIME|declared|R2|publicBaseUrl/);
  });
});
