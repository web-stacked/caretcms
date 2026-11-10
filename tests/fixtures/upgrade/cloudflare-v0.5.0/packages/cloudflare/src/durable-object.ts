import { DurableObject } from "cloudflare:workers";
import {
  handleDurableStorageRequest,
  type DurableStorageLike,
} from "./durable-storage-protocol.js";

/** Durable Object class to re-export from the application's Worker entrypoint. */
export class CaretCmsContent extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    return handleDurableStorageRequest(this.ctx.storage as DurableStorageLike, request);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
