import type { DurableStorageTxn } from "../../packages/cloudflare/src/durable-storage-protocol";
import { handleDurableStorageRequest } from "../../packages/cloudflare/src/durable-storage-protocol";

/** Strong local fake: it does not emulate KV's replication delay or write limits. */
export class MemoryKV {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? null : JSON.parse(value);
  }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

export class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async deleteAll(): Promise<void> { this.values.clear(); }
  async setAlarm(_scheduledTime: number): Promise<void> {}
  transaction<T>(task: (txn: DurableStorageTxn) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const previous = structuredClone(this.values);
      try { return await task(this); }
      catch (error) { this.values = previous; throw error; }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class MemoryDurableNamespace {
  readonly stores = new Map<string, MemoryDurableStorage>();
  idFromName(name: string): string { return name; }
  get(id: unknown) {
    const name = String(id);
    let storage = this.stores.get(name);
    if (!storage) { storage = new MemoryDurableStorage(); this.stores.set(name, storage); }
    return { fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      handleDurableStorageRequest(storage!, input instanceof Request ? input : new Request(input, init)) };
  }
}
