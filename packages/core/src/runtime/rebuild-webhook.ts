export interface RebuildWebhookConfig {
  webhookUrl: string | null;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  /** Defaults to 5 seconds, bounded to 30 seconds. */
  timeoutMs?: number;
}

export interface RebuildWebhookPayload {
  published: Array<{ collection: string; id: string; revision: number; deleted: boolean }>;
  commit: string | null;
  /** Correlates this request with deployment status provider results. */
  deploymentId?: string;
}

export type RebuildWebhookResult =
  | { triggered: false; ok: true }
  | { triggered: true; ok: true; status: number }
  | { triggered: true; ok: false; status?: number; error: string };

export async function triggerRebuildWebhook(
  config: RebuildWebhookConfig,
  payload: RebuildWebhookPayload,
): Promise<RebuildWebhookResult> {
  const webhookUrl = config.webhookUrl?.trim();
  if (!webhookUrl) return { triggered: false, ok: true };

  const controller = new AbortController();
  const timeout = Number.isFinite(config.timeoutMs) ? Math.max(1, Math.min(config.timeoutMs!, 30_000)) : 5_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(webhookUrl, {
      signal: controller.signal,
      method: config.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({
        source: "caretcms",
        event: "publish",
        published: payload.published,
        commit: payload.commit,
        ...(payload.deploymentId ? { deploymentId: payload.deploymentId } : {}),
      }),
    });

    // Only acknowledgement headers matter; don't leave a streaming response open.
    void response.body?.cancel().catch(() => {});

    if (!response.ok) {
      return {
        triggered: true,
        ok: false,
        status: response.status,
        error: `Rebuild webhook failed with status ${response.status}`,
      };
    }

    return { triggered: true, ok: true, status: response.status };
  } catch {
    return {
      triggered: true,
      ok: false,
      error: controller.signal.aborted ? "Rebuild webhook timed out" : "Could not reach rebuild webhook",
    };
  } finally { clearTimeout(timer); }
}
