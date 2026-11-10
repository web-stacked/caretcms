export type CloudflareRuntimeEnv = Record<string, unknown>;

export async function getCloudflareRuntimeEnv(): Promise<CloudflareRuntimeEnv | null> {
  try {
    const mod = await import("cloudflare:workers");
    const env = (mod as { env?: Record<string, unknown> }).env;
    return env ?? null;
  } catch {
    return null;
  }
}
