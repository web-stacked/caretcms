import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageAdapter, UploadHandler } from "../types.js";

export interface CaretRequestContext {
  adapter: StorageAdapter;
  uploadHandler: UploadHandler;
  sessionId: string | null;
  demoMode: boolean;
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
