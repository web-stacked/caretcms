import { describe, expect, it } from 'vitest';
import type { APIContext } from 'astro';
import { GET } from '../../packages/core/src/runtime/routes/entries';
import { runWithRequestContext } from '../../packages/core/src/runtime/request-context';
import { InMemoryAdapter } from '../../packages/core/src/runtime/storage/in-memory-adapter';
import type { UploadHandler } from '../../packages/core/src/types';

// The inline editor reads an entry's current revision (GET /entries) *before*
// its first write. On a greenfield site the target collection does not exist
// yet, so this read must succeed with an empty result — otherwise the first
// edit silently fails before the mutate that would auto-create the collection
// (FR-8). Demo mode satisfies the editor-auth gate without a session cookie.
function callEntries(adapter: InMemoryAdapter, query: string) {
  const context = {
    request: new Request(`http://localhost/api/cms/entries?${query}`),
    cookies: { get: () => undefined },
  } as unknown as APIContext;

  return runWithRequestContext(
    {
      adapter,
      uploadHandler: {} as UploadHandler,
      sessionId: 'demo-session',
      demoMode: true,
    },
    () => GET(context),
  );
}

describe('GET /entries — unknown collection', () => {
  it('returns an empty entry (revision 0) for a valid but not-yet-created collection', async () => {
    const adapter = new InMemoryAdapter();
    expect(await adapter.isKnownCollection('pages')).toBe(false);

    const res = await callEntries(adapter, 'collection=pages&id=home');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('still rejects a malformed collection name with 400', async () => {
    const adapter = new InMemoryAdapter();

    const res = await callEntries(adapter, 'collection=' + encodeURIComponent('../etc/passwd'));
    expect(res.status).toBe(400);
  });
});
