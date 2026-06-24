// Stub for virtual:caretcms/providers — mirror EVERY export the real virtual
// module generates (packages/core/src/index.ts, createRuntimeProvidersPlugin)
// so tests exercise the same module shape instead of silently falling back.
export async function loadConfiguredStorage() {
  return null;
}

export async function loadConfiguredUploadHandler() {
  return null;
}

export const allowedClasses: Record<string, string[]> = {};
export const delivery = {
  mode: "server" as const,
  bake: false,
  publish: {
    webhookUrl: null,
    method: "POST" as const,
    headers: {},
  },
};
export const enableInlineEditor = true;
export const mountPath = "/admin";
export const apiBasePath = "/api/cms";
