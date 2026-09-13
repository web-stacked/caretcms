import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defineConfig } from "astro/config";
import caret, { filesystemStorage, simulatedDeployment } from "@caretcms/core";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  output: "static",
  integrations: [
    caret({
      delivery: {
        mode: "static",
        publish: process.env.STATIC_E2E_WEBHOOK_URL
          ? { webhookUrl: process.env.STATIC_E2E_WEBHOOK_URL }
          : undefined,
      },
      deployment: simulatedDeployment({
        durationMs: 2500,
        result: process.env.STATIC_E2E_DEPLOYMENT_RESULT === "failed" ? "failed" : "live",
      }),
      storage: filesystemStorage({
        dataRoot: join(root, ".caret", "data"),
        metaRoot: join(root, ".caretcms"),
      }),
      schemas: {
        pages: {
          type: "object",
          title: "Pages",
          properties: {
            headline: { type: "string", title: "Headline" },
          },
          required: ["headline"],
        },
      },
      collections: {
        pages: {
          label: "Pages",
          creatable: false,
          orderable: false,
          deletable: false,
        },
      },
    }),
  ],
});
