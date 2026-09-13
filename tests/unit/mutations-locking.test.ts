import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '../../packages/core/src/runtime/storage/in-memory-adapter';
import { executeMutation } from '../../packages/core/src/runtime/mutations/engine';

function freshAdapter(): InMemoryAdapter {
  const adapter = new InMemoryAdapter();
  adapter.preload('pages', [{ id: 'home', data: { headline: 'Hello' } }]);
  return adapter;
}

describe('mutation engine optimistic locking', () => {
  it('returns 409 when expectedRevision does not match', async () => {
    const adapter = freshAdapter();

    const first = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'home',
      field: 'headline',
      value: 'Updated once',
    });
    expect(first.ok).toBe(true);

    const stale = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'home',
      field: 'headline',
      value: 'Stale write',
      expectedRevision: 0,
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('Revision conflict');
    expect(stale.body.currentRevision).toBe(1);
  });

  it('accepts the write when expectedRevision matches', async () => {
    const adapter = freshAdapter();

    const first = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'home',
      field: 'headline',
      value: 'A',
      expectedRevision: 0,
    });
    expect(first.ok).toBe(true);

    const second = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'home',
      field: 'headline',
      value: 'B',
      expectedRevision: 1,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.body.revision).toBe(2);
  });

  it('rejects prototype pollution attempts in field paths', async () => {
    const adapter = freshAdapter();

    const result = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'home',
      field: '__proto__.polluted',
      value: 'yes',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either 400 from setNestedValue throwing or 400 from contracts validation;
    // either is acceptable as long as the mutation is refused.
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);

    // And the prototype is not polluted on a fresh object.
    const sentinel: Record<string, unknown> = {};
    expect((sentinel as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('rejects unknown mutation type', async () => {
    const adapter = freshAdapter();
    const result = await executeMutation(adapter, { type: 'evil_drop_table' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it('recovers the per-key lock after a task throws, with no unhandled rejection (C1)', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      const adapter = freshAdapter();
      // Make the first write throw (simulate a full/read-only disk).
      let failNext = true;
      const original = adapter.writeEntry.bind(adapter);
      adapter.writeEntry = async (collection, id, data) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        return original(collection, id, data);
      };

      await expect(
        executeMutation(adapter, {
          type: 'save_field',
          collection: 'pages',
          id: 'home',
          field: 'headline',
          value: 'first',
        }),
      ).rejects.toThrow('disk full');

      // The next write on the SAME key must not deadlock and must succeed —
      // proving the lock chain recovered after the rejection.
      const recovered = await executeMutation(adapter, {
        type: 'save_field',
        collection: 'pages',
        id: 'home',
        field: 'headline',
        value: 'second',
      });
      expect(recovered.ok).toBe(true);

      // The stored lock promise must have swallowed the rejection: give any
      // dangling unhandled rejection a chance to surface, then assert none did.
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('serializes create_collection so two concurrent creates conflict (C3)', async () => {
    const adapter = new InMemoryAdapter();
    const meta = {
      type: 'create_collection' as const,
      id: 'blog',
      label: 'Blog',
      creatable: true,
      orderable: false,
      schema: { type: 'object', properties: {} },
    };
    const [a, b] = await Promise.all([
      executeMutation(adapter, meta),
      executeMutation(adapter, meta),
    ]);
    // Exactly one wins; the other sees the collection already exists (409).
    const oks = [a, b].filter((r) => r.ok).length;
    const conflicts = [a, b].filter((r) => !r.ok && r.status === 409).length;
    expect(oks).toBe(1);
    expect(conflicts).toBe(1);
  });

  it('serializes reorder against a concurrent save_field on a participating entry', async () => {
    const adapter = new InMemoryAdapter();
    adapter.preload('pages', [
      { id: 'a', data: { title: 'A', order: 0 } },
      { id: 'b', data: { title: 'B', order: 1 } },
    ]);

    // Fire both at once. Without per-entry locks held during reorder, the
    // save_field can land between the reorder's getRevision and bumpRevision
    // for 'a', producing a revision that no client can correctly target next.
    const [reorderResult, saveResult] = await Promise.all([
      executeMutation(adapter, {
        type: 'reorder_entries',
        collection: 'pages',
        items: [
          { id: 'b', order: 0 },
          { id: 'a', order: 1 },
        ],
      }),
      executeMutation(adapter, {
        type: 'save_field',
        collection: 'pages',
        id: 'a',
        field: 'title',
        value: 'A renamed',
      }),
    ]);

    expect(reorderResult.ok).toBe(true);
    expect(saveResult.ok).toBe(true);

    // The serialized total order is either (reorder → save) or (save → reorder).
    // In both orderings the entry's final revision is exactly 2 (one bump per
    // mutation that touched it). A torn schedule would leave revision = 1.
    const aRevision = await adapter.getRevision('pages', 'a');
    expect(aRevision).toBe(2);
  });

  it('rejects duplicate entry ids in an atomic reorder batch', async () => {
    const adapter = freshAdapter();
    const result = await executeMutation(adapter, {
      type: 'reorder_entries',
      collection: 'pages',
      items: [
        { id: 'home', order: 0 },
        { id: 'home', order: 1 },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { issues: [{ path: 'items.1.id', code: 'duplicate' }] },
    });
    expect((await adapter.getEntry('pages', 'home'))?.data).toEqual({ headline: 'Hello' });
    expect(await adapter.getRevision('pages', 'home')).toBe(0);
  });
});
