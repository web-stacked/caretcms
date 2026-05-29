import type { UploadHandler, UploadContext } from "../../types.js";
import { UploadError } from "./image-validation.js";

export interface QuotaCounter {
  read(sessionId: string): Promise<number>;
  write(sessionId: string, used: number): Promise<void>;
}

export interface QuotaUploadHandlerOptions {
  inner: UploadHandler;
  counter: QuotaCounter;
  perSessionBytes?: number;
  perFileBytes?: number;
}

/**
 * Decorates an UploadHandler with per-session size limits. Reads the running
 * session usage from the supplied counter, rejects oversized files, and
 * persists the new total after each successful upload.
 */
export class QuotaUploadHandler implements UploadHandler {
  private readonly inner: UploadHandler;
  private readonly counter: QuotaCounter;
  private readonly perSessionBytes: number;
  private readonly perFileBytes: number;
  // Per-session promise chain so the read→check→upload→write sequence runs
  // atomically and two concurrent uploads can't both read the same `used`,
  // both pass the check, and overshoot the cap (last-writer-wins under-count).
  // NOTE: in-process only — it serializes within a single Node process / Worker
  // isolate, not across a distributed fleet. Good enough for a sandbox soft
  // limit; a hard cross-isolate cap would need an atomic counter (e.g. a
  // Durable Object).
  private readonly sessionChains = new Map<string, Promise<unknown>>();

  constructor(options: QuotaUploadHandlerOptions) {
    this.inner = options.inner;
    this.counter = options.counter;
    this.perSessionBytes = options.perSessionBytes ?? 25 * 1024 * 1024;
    this.perFileBytes = options.perFileBytes ?? 5 * 1024 * 1024;
  }

  private withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // Store a rejection-safe tail for chaining: a rejected upload (e.g. quota
    // exceeded) is observed by the caller via `next`, but the *stored* promise
    // must never reject or it surfaces as an unhandled rejection.
    const tail: Promise<void> = next.then(
      () => {},
      () => {},
    ).finally(() => {
      if (this.sessionChains.get(sessionId) === tail) {
        this.sessionChains.delete(sessionId);
      }
    });
    this.sessionChains.set(sessionId, tail);
    return next;
  }

  async upload(file: File, ctx?: UploadContext): Promise<{ url: string }> {
    if (!ctx?.sessionId) {
      return this.inner.upload(file, ctx);
    }
    const sessionId = ctx.sessionId;

    if (file.size > this.perFileBytes) {
      const limitMb = Math.floor(this.perFileBytes / (1024 * 1024));
      throw new UploadError(`File too large (${limitMb}MB max in sandbox)`);
    }

    return this.withSessionLock(sessionId, async () => {
      const used = await this.counter.read(sessionId);
      if (used + file.size > this.perSessionBytes) {
        throw new UploadError(
          "Sandbox storage full — close this tab to start a fresh session.",
        );
      }

      const result = await this.inner.upload(file, ctx);
      await this.counter.write(sessionId, used + file.size);
      return result;
    });
  }
}
