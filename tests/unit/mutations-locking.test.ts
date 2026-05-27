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
});
