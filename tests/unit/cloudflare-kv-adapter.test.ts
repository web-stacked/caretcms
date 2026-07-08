import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Conformance tests for CloudflareKvStorageAdapter against an in-memory KV fake.
 *
 * Cloudflare KV isn't available off-Workers, so we mock the runtime-env module
 * the adapter uses to fetch its binding and hand it a `MemoryKV` implementing the
 * same get/put/delete surface. This exercises the adapter's index/revision/
 * history plumbing without a live Worker.
 *
 * NOTE: this verifies SINGLE-WRITER correctness. The adapter's optimistic
 * concurrency is NOT safe under concurrent writers on real KV (no compare-and-
 * swap, eventual consistency) — a documented limitation, not something a unit
 * test can paper over. See packages/cloudflare/README.md.
 */

// A minimal KV double: JSON round-trips through a string store, matching how KV
// serializes values and returns parsed JSON for `get(key, "json")`.
class MemoryKV {
  store = new Map<string, string>();
  async get(key: string, _type: 'json'): Promise<unknown> {
    const raw = this.store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const { kvRef } = vi.hoisted(() => ({ kvRef: { current: null as MemoryKV | null } }));

vi.mock('../../packages/cloudflare/src/runtime/env.js', () => ({
  getCloudflareRuntimeEnv: async () => (kvRef.current ? { CMS_KV: kvRef.current } : null),
}));

import { CloudflareKvStorageAdapter } from '../../packages/cloudflare/src/adapters/kv-storage';

function freshAdapter(): CloudflareKvStorageAdapter {
  kvRef.current = new MemoryKV();
  // Disable the bundled-data fallback so tests observe only what they write.
  return new CloudflareKvStorageAdapter({ bundledFallback: false });
}

describe('CloudflareKvStorageAdapter — conformance (MemoryKV)', () => {
  let adapter: CloudflareKvStorageAdapter;

  beforeEach(() => {
    adapter = freshAdapter();
  });

  it('writes and reads back an entry (deep-cloned, not aliased)', async () => {
    const data = { title: 'Hello', nested: { n: 1 } };
    await adapter.writeEntry('pages', 'home', data);

    const read = await adapter.getEntry('pages', 'home');
    expect(read).toEqual({ id: 'home', data: { title: 'Hello', nested: { n: 1 } } });

    // Mutating the source object must not bleed into stored state.
    data.title = 'Changed';
    const reread = await adapter.getEntry('pages', 'home');
    expect(reread?.data.title).toBe('Hello');
  });

  it('returns null for a missing entry', async () => {
    expect(await adapter.getEntry('pages', 'nope')).toBeNull();
  });

  it('maintains the collection index across writes and deletes', async () => {
    await adapter.writeEntry('pages', 'b', { t: 'B' });
    await adapter.writeEntry('pages', 'a', { t: 'A' });
    expect(await adapter.listEntryIds('pages')).toEqual(['a', 'b']); // sorted

    await adapter.deleteEntry('pages', 'a');
    expect(await adapter.listEntryIds('pages')).toEqual(['b']);
    expect(await adapter.getEntry('pages', 'a')).toBeNull();
  });

  it('bumps revisions monotonically and reports them', async () => {
    expect(await adapter.getRevision('pages', 'home')).toBe(0);
    await adapter.writeEntry('pages', 'home', { t: '1' });
    expect(await adapter.bumpRevision('pages', 'home')).toBe(1);
    expect(await adapter.bumpRevision('pages', 'home')).toBe(2);
    expect(await adapter.getRevision('pages', 'home')).toBe(2);
  });

  it('coerces a corrupt/non-integer revision to 0', async () => {
    kvRef.current!.store.set('rev::pages::home', JSON.stringify('not-a-number'));
    expect(await adapter.getRevision('pages', 'home')).toBe(0);
  });

  it('records history newest-first', async () => {
    await adapter.appendHistory('pages', 'home', { ts: 1, action: 'save', data: { v: 1 } });
    await adapter.appendHistory('pages', 'home', { ts: 2, action: 'save', data: { v: 2 } });
    const history = await adapter.getHistory('pages', 'home');
    expect(history.map((h) => h.ts)).toEqual([2, 1]);
  });

  it('creates and lists collection metadata', async () => {
    const meta = {
      id: 'blog',
      label: 'Blog',
      created_at: 1,
      updated_at: 1,
      schema: { type: 'object', properties: {} },
    };
    await adapter.createCollection(meta as never);
    expect(await adapter.isKnownCollection('blog')).toBe(true);
    expect(await adapter.getCollectionMetadata('blog')).toMatchObject({ id: 'blog', label: 'Blog' });
    const all = await adapter.listCollectionMetadata();
    expect(all.map((m) => m.id)).toContain('blog');
  });

  it('rejects an invalid collection id on create', async () => {
    await expect(
      adapter.createCollection({ id: 'Bad Id', label: 'x', created_at: 1, updated_at: 1, schema: {} } as never),
    ).rejects.toThrow();
  });

  it('deleteCollection removes entries, revisions, history, index, and metadata', async () => {
    const meta = { id: 'blog', label: 'Blog', created_at: 1, updated_at: 1, schema: { type: 'object', properties: {} } };
    await adapter.createCollection(meta as never);
    await adapter.writeEntry('blog', 'post', { t: 'P' });
    await adapter.bumpRevision('blog', 'post');
    await adapter.appendHistory('blog', 'post', { ts: 1, action: 'save', data: {} });

    await adapter.deleteCollection('blog');

    expect(await adapter.isKnownCollection('blog')).toBe(false);
    expect(await adapter.getEntry('blog', 'post')).toBeNull();
    // No orphaned rev/history/index/meta keys remain.
    const leftover = [...kvRef.current!.store.keys()].filter((k) => k.includes('blog'));
    expect(leftover).toEqual([]);
  });

  it('isolates a session overlay behind a key prefix', async () => {
    await adapter.writeEntry('pages', 'home', { t: 'base' });
    const overlay = await adapter.makeSessionOverlay('11111111-1111-1111-1111-111111111111');
    await overlay.writeEntry('pages', 'home', { t: 'draft' });

    // Overlay and base see their own values; keys are namespaced.
    expect((await overlay.getEntry('pages', 'home'))?.data.t).toBe('draft');
    expect((await adapter.getEntry('pages', 'home'))?.data.t).toBe('base');
  });
});
