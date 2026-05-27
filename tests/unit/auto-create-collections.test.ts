import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '../../packages/core/src/runtime/storage/in-memory-adapter';
import { executeMutation } from '../../packages/core/src/runtime/mutations/engine';

describe('auto-create collections on first write', () => {
  it('save_field creates entry in a new collection', async () => {
    const adapter = new InMemoryAdapter();

    // Collection "pages" does not exist yet
    expect(await adapter.isKnownCollection('pages')).toBe(false);

    const result = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'title',
      value: 'Hello World',
    });

    expect(result.ok).toBe(true);

    // Collection was auto-created
    const entry = await adapter.getEntry('pages', 'about');
    expect(entry).not.toBeNull();
    expect(entry!.data.title).toBe('Hello World');
  });

  it('put_entry creates entry in a new collection', async () => {
    const adapter = new InMemoryAdapter();

    const result = await executeMutation(adapter, {
      type: 'put_entry',
      collection: 'site',
      id: 'config',
      data: { name: 'My Site', tagline: 'The best' },
    });

    expect(result.ok).toBe(true);

    const entry = await adapter.getEntry('site', 'config');
    expect(entry).not.toBeNull();
    expect(entry!.data.name).toBe('My Site');
  });

  it('normalizes uppercase collection names to lowercase', async () => {
    const adapter = new InMemoryAdapter();

    const result = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'PAGES',
      id: 'about',
      field: 'title',
      value: 'test',
    });

    // PAGES is normalized to pages — should succeed
    expect(result.ok).toBe(true);
    const entry = await adapter.getEntry('pages', 'about');
    expect(entry).not.toBeNull();
  });

  it('rejects collection names starting with numbers', async () => {
    const adapter = new InMemoryAdapter();

    const result = await executeMutation(adapter, {
      type: 'save_field',
      collection: '123pages',
      id: 'about',
      field: 'title',
      value: 'test',
    });

    expect(result.ok).toBe(false);
  });

  it('rejects collection names with special characters', async () => {
    const adapter = new InMemoryAdapter();

    const result = await executeMutation(adapter, {
      type: 'save_field',
      collection: '../etc/passwd',
      id: 'about',
      field: 'title',
      value: 'test',
    });

    expect(result.ok).toBe(false);
  });

  it('accepts valid collection names with hyphens and underscores', async () => {
    const adapter = new InMemoryAdapter();

    const result = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'my-site_pages',
      id: 'home',
      field: 'title',
      value: 'Home',
    });

    expect(result.ok).toBe(true);
  });
});
