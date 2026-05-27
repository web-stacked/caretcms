import type { UploadHandler, UploadContext } from "../../types.js";

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

  constructor(options: QuotaUploadHandlerOptions) {
    this.inner = options.inner;
    this.counter = options.counter;
    this.perSessionBytes = options.perSessionBytes ?? 25 * 1024 * 1024;
    this.perFileBytes = options.perFileBytes ?? 5 * 1024 * 1024;
  }

  async upload(file: File, ctx?: UploadContext): Promise<{ url: string }> {
    if (!ctx?.sessionId) {
      return this.inner.upload(file, ctx);
    }

    if (file.size > this.perFileBytes) {
      const limitMb = Math.floor(this.perFileBytes / (1024 * 1024));
      throw new Error(`File too large (${limitMb}MB max in sandbox)`);
    }

    const used = await this.counter.read(ctx.sessionId);
    if (used + file.size > this.perSessionBytes) {
      throw new Error("Sandbox storage full — close this tab to start a fresh session.");
    }

    const result = await this.inner.upload(file, ctx);
    await this.counter.write(ctx.sessionId, used + file.size);
    return result;
  }
}
