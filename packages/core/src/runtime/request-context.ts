import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageAdapter, UploadHandler } from "../types.js";

export interface CaretRequestContext {
  adapter: StorageAdapter;
  uploadHandler: UploadHandler;
  sessionId: string | null;
  demoMode: boolean;
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
