export interface RebuildWebhookConfig {
  webhookUrl: string | null;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
}

export interface RebuildWebhookPayload {
  published: Array<{ collection: string; id: string; revision: number; deleted: boolean }>;
  commit: string | null;
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

  try {
    const response = await fetch(webhookUrl, {
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
      }),
    });

    if (!response.ok) {
      return {
        triggered: true,
        ok: false,
        status: response.status,
        error: `Rebuild webhook failed with status ${response.status}`,
      };
    }

    return { triggered: true, ok: true, status: response.status };
  } catch (error) {
    return {
      triggered: true,
      ok: false,
      error: error instanceof Error ? error.message : "Rebuild webhook failed",
    };
  }
}
