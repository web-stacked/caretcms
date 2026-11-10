import caret, { type StorageAdapter, type CaretStorageProvider } from "@caretcms/core";
import { cloudflareDurableStorage, CloudflareDurableStorageAdapter } from "@caretcms/cloudflare";
import { schemasFromZod } from "@caretcms/zod";
import { planFile } from "@caretcms/caretize";
import { z } from "zod";

const storage: CaretStorageProvider = cloudflareDurableStorage({ editorDrafts: "coordinated" });
const adapter: StorageAdapter = new CloudflareDurableStorageAdapter();
caret({ storage, schemas: schemasFromZod({ pages: z.object({ title: z.string() }) }) });
void adapter;
void planFile("<h1>Example</h1>", "src/pages/index.astro");
