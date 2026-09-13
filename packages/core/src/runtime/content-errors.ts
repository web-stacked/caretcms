export class ContentReadError extends Error {
  constructor(public readonly code: "unsupported_content" | "invalid_content" | "storage_error") {
    super(code);
  }
}

export function contentReadFailure(error: unknown): { code: string; error: string } {
  if (error instanceof ContentReadError && error.code === "unsupported_content") {
    return { code: error.code, error: "This entry uses unsupported frontmatter syntax. Update its source format and retry; the file has not been changed." };
  }
  if (error instanceof ContentReadError && error.code === "invalid_content") {
    return { code: error.code, error: "This entry contains invalid content. Correct its source file and retry." };
  }
  return { code: "storage_error", error: "Could not read this entry from storage. Check storage access and retry." };
}
