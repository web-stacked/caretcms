import { describe, expect, it } from 'vitest';
import { rewriteCaretAttributes } from '../../packages/core/src/runtime/rewrite';
import { InMemoryAdapter } from '../../packages/core/src/runtime/storage/in-memory-adapter';

function makeAdapter(data: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const adapter = new InMemoryAdapter();
  // Seed data: data[collection][id] = { field: value }
  for (const [collection, entries] of Object.entries(data)) {
    for (const [id, fields] of Object.entries(entries)) {
      // writeEntry is async, but we call it in beforeAll-style via the returned promise
      adapter.writeEntry(collection, id, fields);
    }
  }
  return adapter;
}

describe('rewriteCaretAttributes', () => {
  it('replaces text content for absolute key', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero_title: 'Stored Title' } },
    });
    // Allow writes to settle
    await new Promise((r) => setTimeout(r, 10));

    const html = '<h1 data-caret="pages::about::hero_title">Default Title</h1>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Stored Title');
    expect(result).not.toContain('Default Title');
    expect(result).toContain('data-caret="pages::about::hero_title"');
  });

  it('resolves scoped field to nearest scope ancestor', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero_desc: 'Stored Desc' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <section data-caret-scope="pages::about">
        <p data-caret="hero_desc">Default Desc</p>
      </section>
    `;
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Stored Desc');
    expect(result).not.toContain('Default Desc');
  });

  it('absolute key takes precedence over scope', async () => {
    const adapter = makeAdapter({
      site: { global: { tagline: 'Global Tagline' } },
      pages: { about: { tagline: 'About Tagline' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <section data-caret-scope="pages::about">
        <h1 data-caret="site::global::tagline">Default</h1>
      </section>
    `;
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Global Tagline');
    expect(result).not.toContain('About Tagline');
  });

  it('does not rewrite when scope is missing for field-only binding', async () => {
    const adapter = makeAdapter({
      pages: { about: { title: 'Stored' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    // No data-caret-scope anywhere
    const html = '<h1 data-caret="title">Default</h1>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Default');
    expect(result).not.toContain('Stored');
  });

  // C6: the scope-frame stack is maintained by scanning tags between the cursor
  // and each binding. Tag-like text that the browser never treats as a tag —
  // inside comments, <script>/<style>/<textarea> bodies, or a quoted attribute
  // value containing `>` — must NOT corrupt the stack, or a field-only binding
  // resolves against the wrong collection::id.
  it('ignores tags inside HTML comments when tracking scope', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero_desc: 'Stored Desc' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <section data-caret-scope="pages::about">
        <!-- <div data-caret-scope="pages::other"> a commented-out block </div> -->
        <p data-caret="hero_desc">Default Desc</p>
      </section>
    `;
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Stored Desc');
  });

  it('ignores tag-like text inside <script> bodies when tracking scope', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero_desc: 'Stored Desc' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <section data-caret-scope="pages::about">
        <script>if (a < b && c > d) { render('<section>'); }</script>
        <p data-caret="hero_desc">Default Desc</p>
      </section>
    `;
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Stored Desc');
  });

  it('closes tags on the real > not a > inside a quoted attribute', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero_desc: 'Stored Desc' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <section data-caret-scope="pages::about">
        <a href="/search?q=a>b" title="x>y">link</a>
        <p data-caret="hero_desc">Default Desc</p>
      </section>
    `;
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Stored Desc');
  });

  it('does not leak scope across sibling sections', async () => {
    const adapter = makeAdapter({
      pages: { first: { title: 'Stored First Title' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <section data-caret-scope="pages::first">
        <p>Scoped block</p>
      </section>
      <div>
        <h1 data-caret="title">Default</h1>
      </div>
    `;

    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Default');
    expect(result).not.toContain('Stored First Title');
  });

  it('skips elements with nested child markup', async () => {
    const adapter = makeAdapter({
      pages: { about: { bad: 'Stored' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = '<p data-caret="pages::about::bad"><strong>Bold</strong> text</p>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('<strong>Bold</strong> text');
    expect(result).not.toContain('Stored');
  });

  it('swaps img src attribute', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero_img: '/images/new.jpg' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = '<img data-caret="pages::about::hero_img" src="/images/old.jpg" alt="Hero" />';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('src="/images/new.jpg"');
    expect(result).not.toContain('src="/images/old.jpg"');
  });

  it('swaps img src for a void <img> with no self-closing slash', async () => {
    // Standard HTML5 / Astro output: void <img> closes on a bare `>` with no
    // closing tag and no `/`. This is the form that actually ships, and the
    // form a self-closing-only matcher silently skips.
    const adapter = makeAdapter({
      pages: { home: { hero: { image: '/uploads/new.webp' } } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html =
      '<main data-caret-scope="pages::home"><img data-caret="hero.image" src="/initial.png" width="96"></main>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('src="/uploads/new.webp"');
    expect(result).not.toContain('src="/initial.png"');
  });

  it('leaves default when no stored value exists', async () => {
    const adapter = makeAdapter({});

    const html = '<h1 data-caret="pages::about::title">Default</h1>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Default');
  });

  it('handles multiple bindings on same page', async () => {
    const adapter = makeAdapter({
      pages: { about: { title: 'New Title', desc: 'New Desc' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = `
      <h1 data-caret="pages::about::title">Old Title</h1>
      <p data-caret="pages::about::desc">Old Desc</p>
    `;
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('New Title');
    expect(result).toContain('New Desc');
    expect(result).not.toContain('Old Title');
    expect(result).not.toContain('Old Desc');
  });

  it('batch loads entries — only one getEntry per unique collection::id', async () => {
    let getEntryCalls = 0;
    const adapter = makeAdapter({
      pages: { about: { title: 'T', desc: 'D' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const origGetEntry = adapter.getEntry.bind(adapter);
    adapter.getEntry = async (collection: string, id: string) => {
      getEntryCalls++;
      return origGetEntry(collection, id);
    };

    const html = `
      <h1 data-caret="pages::about::title">A</h1>
      <p data-caret="pages::about::desc">B</p>
    `;
    await rewriteCaretAttributes(html, adapter);
    expect(getEntryCalls).toBe(1); // One getEntry call for pages::about
  });

  it('escapes HTML in stored text values', async () => {
    const adapter = makeAdapter({
      pages: { about: { title: '<script>alert("xss")</script>' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = '<h1 data-caret="pages::about::title">Safe</h1>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes attribute values in img src', async () => {
    const adapter = makeAdapter({
      pages: { about: { img: '"><script>alert(1)</script>' } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = '<img data-caret="pages::about::img" src="/safe.jpg" />';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&quot;');
  });

  it('handles nested dot-path fields', async () => {
    const adapter = makeAdapter({
      pages: { about: { hero: { title: 'Nested Title' } } },
    });
    await new Promise((r) => setTimeout(r, 10));

    const html = '<h1 data-caret="pages::about::hero.title">Default</h1>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toContain('Nested Title');
  });

  it('passes through HTML with no data-caret attributes unchanged', async () => {
    const adapter = makeAdapter({});
    const html = '<h1>Hello World</h1><p>No CMS here</p>';
    const result = await rewriteCaretAttributes(html, adapter);
    expect(result).toBe(html);
  });
});
