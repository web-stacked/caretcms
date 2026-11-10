import type { GitJournalReceipt } from "../types.js";
import { COLLECTION_NAME_RE, ENTRY_ID_RE } from "./storage/id-contracts.js";

export function validGitJournalReceipt(value: unknown): value is GitJournalReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as GitJournalReceipt;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("\0");
  const target = receipt.target;
  return receipt.version === 1 && text(receipt.operationId) &&
    text(receipt.collection) && COLLECTION_NAME_RE.test(receipt.collection) && text(receipt.id) && ENTRY_ID_RE.test(receipt.id) &&
    Number.isSafeInteger(receipt.revision) && receipt.revision > 0 && typeof receipt.deleted === "boolean" &&
    text(receipt.authorName) && text(receipt.authorEmail) && Boolean(target && text(target.root) && text(target.gitDir) &&
      text(target.ref) && (target.ref === "HEAD" || target.ref.startsWith("refs/heads/")) &&
      (target.head === null || (typeof target.head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.head)))) &&
    Array.isArray(receipt.sources) && receipt.sources.length > 0 && receipt.sources.every(source =>
      source && text(source.path) && (source.content === null || typeof source.content === "string") &&
      (source.mode === undefined || source.mode === "100644" || source.mode === "100755"));
}
