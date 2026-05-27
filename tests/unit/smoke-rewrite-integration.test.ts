import { describe, expect, it } from 'vitest';
import { rewriteCaretAttributes } from '../../packages/core/src/runtime/rewrite';
import { executeMutation } from '../../packages/core/src/runtime/mutations/engine';
import { InMemoryAdapter } from '../../packages/core/src/runtime/storage/in-memory-adapter';

/**
 * Smoke test: Full integration of attribute-first CMS flow.
 * Simulates: render HTML → edit via mutation → re-render with stored overrides.
 */

const SMOKE_HTML = `<!DOCTYPE html>
<html>
<head><title>Smoke Test</title></head>
<body>

  <!-- Scoped section -->
  <section data-caret-scope="pages::about">
    <h1 data-caret="hero_title">Default Hero Title</h1>
    <p data-caret="hero_desc">Default hero description text.</p>
    <img data-caret="hero_img" src="/images/default-hero.jpg" alt="Hero" />
  </section>

  <!-- Absolute key outside scope -->
  <h2 data-caret="site::global::tagline">Default Tagline</h2>

  <!-- Nested markup — should be SKIPPED -->
  <p data-caret="pages::about::bad_field"><strong>Bold</strong> and <em>italic</em> text</p>

  <!-- Field-only without any scope — should be SKIPPED -->
  <span data-caret="orphan_field">Orphan Default</span>

  <!-- Multiple elements same entry -->
  <footer data-caret-scope="site::footer">
    <span data-caret="copyright">© 2026</span>
    <span data-caret="company">Default Co</span>
  </footer>

</body>
</html>`;

describe('smoke: full attribute-first CMS flow', () => {
  it('renders defaults when no stored overrides exist', async () => {
    const adapter = new InMemoryAdapter();
    const result = await rewriteCaretAttributes(SMOKE_HTML, adapter);

    expect(result).toContain('Default Hero Title');
    expect(result).toContain('Default hero description text.');
    expect(result).toContain('src="/images/default-hero.jpg"');
    expect(result).toContain('Default Tagline');
    expect(result).toContain('<strong>Bold</strong>');
    expect(result).toContain('Orphan Default');
    expect(result).toContain('© 2026');
  });

  it('edit flow: mutate → rewrite shows stored values', async () => {
    const adapter = new InMemoryAdapter();

    // Step 1: Client edits hero_title via save_field mutation
    const r1 = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_title',
      value: 'Edited Hero Title',
    });
    expect(r1.ok).toBe(true);

    // Step 2: Client edits hero_desc
    const r2 = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_desc',
      value: 'Edited description.',
    });
    expect(r2.ok).toBe(true);

    // Step 3: Client uploads new image
    const r3 = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_img',
      value: '/uploads/new-hero.webp',
    });
    expect(r3.ok).toBe(true);

    // Step 4: Rewrite the page — stored values should replace defaults
    const result = await rewriteCaretAttributes(SMOKE_HTML, adapter);

    // Scoped fields resolve and are overridden
    expect(result).toContain('Edited Hero Title');
    expect(result).not.toContain('Default Hero Title');
    expect(result).toContain('Edited description.');
    expect(result).not.toContain('Default hero description text.');
    expect(result).toContain('src="/uploads/new-hero.webp"');
    expect(result).not.toContain('src="/images/default-hero.jpg"');
  });

  it('nested markup is preserved and not rewritten', async () => {
    const adapter = new InMemoryAdapter();

    // Even if we save a value for the bad_field, it should NOT be used
    await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'bad_field',
      value: 'This should not appear',
    });

    const result = await rewriteCaretAttributes(SMOKE_HTML, adapter);

    // The original nested markup should be intact
    expect(result).toContain('<strong>Bold</strong> and <em>italic</em> text');
    expect(result).not.toContain('This should not appear');
  });

  it('orphan field without scope is not rewritten', async () => {
    const adapter = new InMemoryAdapter();

    const result = await rewriteCaretAttributes(SMOKE_HTML, adapter);
    expect(result).toContain('Orphan Default');
  });

  it('absolute key within a scope resolves to its own key', async () => {
    const adapter = new InMemoryAdapter();

    await executeMutation(adapter, {
      type: 'save_field',
      collection: 'site',
      id: 'global',
      field: 'tagline',
      value: 'New Tagline',
    });

    const result = await rewriteCaretAttributes(SMOKE_HTML, adapter);

    expect(result).toContain('New Tagline');
    expect(result).not.toContain('Default Tagline');
  });

  it('multiple scopes on same page work independently', async () => {
    const adapter = new InMemoryAdapter();

    await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_title',
      value: 'About Title',
    });

    await executeMutation(adapter, {
      type: 'save_field',
      collection: 'site',
      id: 'footer',
      field: 'copyright',
      value: '© 2027 Updated',
    });

    const result = await rewriteCaretAttributes(SMOKE_HTML, adapter);

    expect(result).toContain('About Title');
    expect(result).toContain('© 2027 Updated');
    // company was not edited — should retain default
    expect(result).toContain('Default Co');
  });

  it('revision conflict returns 409 on second conflicting write', async () => {
    const adapter = new InMemoryAdapter();

    // First write succeeds
    const r1 = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_title',
      value: 'First',
    });
    expect(r1.ok).toBe(true);
    const rev1 = r1.ok ? r1.body.revision : -1;

    // Second write with wrong revision
    const r2 = await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_title',
      value: 'Conflict',
      expectedRevision: 0, // stale — actual is rev1
    });

    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.status).toBe(409);
    }
  });

  it('history snapshot is created on save', async () => {
    const adapter = new InMemoryAdapter();

    await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_title',
      value: 'Version 1',
    });

    await executeMutation(adapter, {
      type: 'save_field',
      collection: 'pages',
      id: 'about',
      field: 'hero_title',
      value: 'Version 2',
    });

    const history = await adapter.getHistory('pages', 'about');
    expect(history.length).toBeGreaterThanOrEqual(2);
    // Most recent snapshot first
    expect(history[0].action).toBe('save');
  });
});
