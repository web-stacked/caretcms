import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageAdapter, UploadHandler } from "../types.js";

export interface CaretRequestContext {
  adapter: StorageAdapter;
  uploadHandler: UploadHandler;
  sessionId: string | null;
  demoMode: boolean;
  /**
   * True when this request is from an authenticated editor (or an active demo
   * overlay). Gates draft-only behavior such as stega encoding in the live
   * loaders. Set by the middleware after auth is resolved; absent means false.
   */
  editor?: boolean;
  /**
   * The authenticated editor's id (from the session cookie), when present. Keys
   * the per-editor draft overlay so unpublished edits stay isolated per editor.
   * Absent for anonymous/public requests and legacy sessions.
   */
  editorId?: string | null;
  /**
   * True only when a per-session storage overlay was actually installed for
   * this demo request, guaranteeing writes are isolated from the shared base
   * store. Demo editor rights are granted only when this holds — see
   * `isEditorAuthenticated`. Absent/false means fail closed.
   */
  overlayActive?: boolean;
}

const storage = new AsyncLocalStorage<CaretRequestContext>();

export function runWithRequestContext<T>(
  context: CaretRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getRequestContext(): CaretRequestContext | undefined {
  return storage.getStore();
}

export function requireRequestContext(): CaretRequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "[caretcms] No live request context found. Ensure the CMS middleware runs before page rendering (it registers with order: 'pre').",
    );
  }
  return ctx;
}
