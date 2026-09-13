declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export class DurableObject {
    protected readonly ctx: {
      storage: {
        get<T = unknown>(key: string): Promise<T | undefined>;
        put<T>(key: string, value: T): Promise<void>;
        delete(key: string): Promise<unknown>;
        deleteAll(): Promise<void>;
        setAlarm(scheduledTime: number): Promise<void>;
        transaction<T>(task: (txn: {
          get<TValue = unknown>(key: string): Promise<TValue | undefined>;
          put<TValue>(key: string, value: TValue): Promise<void>;
          delete(key: string): Promise<unknown>;
        }) => Promise<T>): Promise<T>;
      };
    };
  }
}
