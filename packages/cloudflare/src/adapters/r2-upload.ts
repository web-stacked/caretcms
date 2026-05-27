import type { UploadContext, UploadHandler } from "@caretcms/core";
import {
  IMAGE_KIND_TO_EXT,
  QuotaUploadHandler,
  readAndValidateImage,
  sanitizeImageBaseName,
} from "@caretcms/core/runtime";
import type { QuotaCounter } from "@caretcms/core/runtime";
import { getCloudflareRuntimeEnv } from "../runtime/env.js";

const KIND_TO_CONTENT_TYPE = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
} as const;

type KvBindingLike = {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

const QUOTA_TTL_SECONDS = 60 * 60 * 2; // matches demo session window

class KvQuotaCounter implements QuotaCounter {
  constructor(private readonly binding: string) {}

  private async kv(): Promise<KvBindingLike | null> {
    const env = await getCloudflareRuntimeEnv();
    const candidate = env?.[this.binding];
    if (!candidate || typeof candidate !== "object") return null;
    const kv = candidate as { get?: unknown; put?: unknown };
    if (typeof kv.get !== "function" || typeof kv.put !== "function") return null;
    return candidate as KvBindingLike;
  }

  async read(sessionId: string): Promise<number> {
    const kv = await this.kv();
    if (!kv) return 0;
    const raw = await kv.get(`session/${sessionId}/__bytes__`, "json");
    return typeof raw === "number" && raw >= 0 ? raw : 0;
  }

  async write(sessionId: string, used: number): Promise<void> {
    const kv = await this.kv();
    if (!kv) return;
    await kv.put(
      `session/${sessionId}/__bytes__`,
      JSON.stringify(used),
      { expirationTtl: QUOTA_TTL_SECONDS },
    );
  }
}

type R2BucketLike = {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ): Promise<unknown>;
};

async function getBucket(binding: string): Promise<R2BucketLike | null> {
  const env = await getCloudflareRuntimeEnv();
  const candidate = env?.[binding];
  if (!candidate || typeof candidate !== "object") return null;

  const bucket = candidate as { put?: unknown };
  if (typeof bucket.put !== "function") return null;
  return candidate as R2BucketLike;
}

async function resolvePublicBaseUrl(configured: string | null): Promise<string | null> {
  if (configured) return configured;

  const env = await getCloudflareRuntimeEnv();
  const raw = env?.R2_PUBLIC_DOMAIN;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  const trimmed = raw.trim().replace(/\/$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export interface R2UploadHandlerOptions extends Record<string, unknown> {
  binding?: string;
  publicBaseUrl?: string;
  devServePath?: string;
  /**
   * KV binding used to track per-session upload byte totals when demo mode is
   * active. Defaults to "CMS_KV" — the same binding used by the storage
   * adapter's session overlay.
   */
  quotaBinding?: string;
  /** Per-file size cap in demo sandboxes. Defaults to 5MB. */
  sandboxPerFileBytes?: number;
  /** Per-session total upload cap in demo sandboxes. Defaults to 25MB. */
  sandboxPerSessionBytes?: number;
}

export class R2UploadHandler implements UploadHandler {
  private readonly binding: string;
  private readonly publicBaseUrl: string | null;
  private readonly devServePath: string;
  private readonly quotaBinding: string;
  private readonly sandboxPerFileBytes: number;
  private readonly sandboxPerSessionBytes: number;

  constructor(options: R2UploadHandlerOptions = {}) {
    this.binding = options.binding ?? "CMS_R2";
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/$/, "") ?? null;
    this.devServePath = options.devServePath ?? "/api/cms/image";
    this.quotaBinding = options.quotaBinding ?? "CMS_KV";
    this.sandboxPerFileBytes = options.sandboxPerFileBytes ?? 5 * 1024 * 1024;
    this.sandboxPerSessionBytes = options.sandboxPerSessionBytes ?? 25 * 1024 * 1024;
  }

  async makeSessionWrapper(_sessionId: string): Promise<UploadHandler> {
    return new QuotaUploadHandler({
      inner: this,
      counter: new KvQuotaCounter(this.quotaBinding),
      perFileBytes: this.sandboxPerFileBytes,
      perSessionBytes: this.sandboxPerSessionBytes,
    });
  }

  async upload(file: File, ctx?: UploadContext): Promise<{ url: string }> {
    // Buffer + magic-byte verify before touching R2 so a spoofed
    // Content-Type can't land an HTML/SVG payload under an image/* MIME.
    const { kind, bytes } = await readAndValidateImage(file);

    const bucket = await getBucket(this.binding);
    if (!bucket) {
      throw new Error(
        `[caretcms] Cloudflare R2 binding "${this.binding}" is not available.`,
      );
    }

    const timestamp = Date.now().toString(36);
    // Discard the client-supplied extension and re-derive from verified bytes.
    // Prevents `evil.html.jpg`-style double extensions from reaching the key.
    const safeName = sanitizeImageBaseName(file.name) || `upload-${timestamp}`;
    const ext = IMAGE_KIND_TO_EXT[kind];
    const verifiedContentType = KIND_TO_CONTENT_TYPE[kind];
    const prefix = ctx?.sessionId ? `session/${ctx.sessionId}/` : "";
    const key = `${prefix}${crypto.randomUUID()}-${safeName}.${ext}`;

    await bucket.put(key, bytes, {
      httpMetadata: { contentType: verifiedContentType },
    });

    const publicBaseUrl = await resolvePublicBaseUrl(this.publicBaseUrl);
    if (import.meta.env.DEV || !publicBaseUrl) {
      return { url: `${this.devServePath}/${key}` };
    }

    return { url: `${publicBaseUrl}/${key}` };
  }
}
