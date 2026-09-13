import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';
import type { AuthorizationRequest } from '../../packages/core/src/types';
import { onRequest } from '../../packages/core/src/runtime/middleware';
import { __setRuntimeServicesForTests } from '../../packages/core/src/runtime/providers';
import { InMemoryAdapter } from '../../packages/core/src/runtime/storage/in-memory-adapter';
import { POST as mutate } from '../../packages/core/src/runtime/routes/mutate';
import { POST as publish } from '../../packages/core/src/runtime/routes/publish';
import { POST as restore } from '../../packages/core/src/runtime/routes/history';
import { POST as upload } from '../../packages/core/src/runtime/routes/upload';
import { GET as session } from '../../packages/core/src/runtime/routes/auth-session';

const base = () => { const adapter = new InMemoryAdapter(); adapter.preload('pages', [{ id: 'home', data: { title: 'Original' } }, { id: 'locked', data: { title: 'Locked' } }]); return adapter; };
let policy: (input: AuthorizationRequest) => boolean | Promise<boolean>;
function setup(adapter = base()) {
  __setRuntimeServicesForTests({ adapter, uploadHandler: { upload: vi.fn() }, identityAdapter: {
    authenticate: async request => ({ id: request.headers.get('x-test-editor') ?? 'writer', roles: ['writer'] }),
    loginUrl: () => '/login', authorize: input => policy(input),
  } }); return adapter;
}
async function call(route: (ctx: APIContext) => Promise<Response>, body?: unknown, editor = 'writer') {
  const request = new Request('http://localhost/api/cms/test', { method: body === undefined ? 'GET' : 'POST', headers: { 'x-caret-request': '1', 'content-type': 'application/json', 'x-test-editor': editor }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ctx = { request, url: new URL(request.url), locals: {}, cookies: { get: () => undefined } };
  return onRequest(ctx, () => route(ctx as unknown as APIContext));
}
const edit = (id = 'home') => ({ type: 'put_entry', collection: 'pages', id, data: { title: 'Draft' } });
afterEach(() => __setRuntimeServicesForTests(null));

describe('authorization policy', () => {
  it('forces private drafts in server delivery and keeps editor identities isolated', async () => {
    policy = ({ action }) => action === 'edit'; const adapter = setup();
    expect((await call(mutate, edit())).status).toBe(200);
    expect((await adapter.getEntry('pages', 'home'))!.data.title).toBe('Original');
    expect((await (await adapter.makeEditorOverlay('writer')).getEntry('pages', 'home'))!.data.title).toBe('Draft');
    expect(await (await adapter.makeEditorOverlay('other')).getEntry('pages', 'home')).toBeNull();
    expect((await call(publish, {})).status).toBe(403);
    expect((await call(restore, { collection: 'pages', id: 'home', ts: 1 })).status).toBe(403);
    expect((await call(upload, {})).status).toBe(403);
    const permissions = await (await call(session)).json();
    expect(permissions).toMatchObject({ draftMode: true, permissions: { edit: true, publish: false, delete: false, upload: false, manageCollections: false } });
  });

  it('denies direct commands and checks every reorder target before any changes', async () => {
    policy = ({ action, id }) => action === 'edit' && id === 'home'; const adapter = setup();
    for (const command of [edit('locked'), { type: 'delete_entry', collection: 'pages', id: 'home' }, { type: 'delete_collection', id: 'pages' }, { type: 'create_collection', id: 'new', label: 'New', schema: { type: 'object', properties: {} } }, { type: 'reorder_entries', collection: 'pages', items: [{ id: 'home', order: 1 }, { id: 'locked', order: 0 }] }]) {
      expect((await call(mutate, command)).status).toBe(403);
    }
    expect(await (await adapter.makeEditorOverlay('writer')).listEntryIds('pages')).toEqual([]);
  });

  it('preflights bulk publish before touching any authorized entry and allows an explicitly scoped publish', async () => {
    policy = ({ action }) => action === 'edit'; const adapter = setup();
    await call(mutate, edit()); await call(mutate, edit('locked'));
    policy = ({ action, id }) => action === 'publish' && id === 'home';
    expect((await call(publish, {})).status).toBe(403);
    expect((await adapter.getEntry('pages', 'home'))!.data.title).toBe('Original');
    expect((await call(publish, { collection: 'pages', id: 'home' })).status).toBe(200);
    expect((await adapter.getEntry('pages', 'home'))!.data.title).toBe('Draft');
    expect((await adapter.getHistory('pages', 'home'))[0].editor?.id).toBe('writer');
    expect((await (await adapter.makeEditorOverlay('writer')).getEntry('pages', 'locked'))!.data.title).toBe('Draft');
  });

  it('checks delete again at publication and rechecks permissions on the next request', async () => {
    policy = () => true; const adapter = setup();
    expect((await call(mutate, { type: 'delete_entry', collection: 'pages', id: 'home' })).status).toBe(200);
    policy = ({ action }) => action !== 'delete';
    expect((await call(publish, {})).status).toBe(403);
    expect(await adapter.getEntry('pages', 'home')).not.toBeNull();
    policy = () => true;
    expect((await call(publish, {})).status).toBe(200);
    expect(await adapter.getEntry('pages', 'home')).toBeNull();
  });

  it('fails closed on exceptions, non-boolean answers and missing draft support', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setup(); policy = () => { throw new Error('private policy failure'); };
      expect(await (await call(mutate, edit())).text()).not.toContain('private policy');
      expect((await call(mutate, edit())).status).toBe(403);
      policy = (() => 'yes') as unknown as typeof policy;
      expect((await call(mutate, edit())).status).toBe(403);
      const adapter = base(); Object.assign(adapter, { makeEditorOverlay: undefined }); setup(adapter); policy = () => true;
      expect((await call(mutate, edit())).status).toBe(503);
      expect((await adapter.getEntry('pages', 'home'))!.data.title).toBe('Original');
    } finally { error.mockRestore(); }
  });

  it('gates deployment retries before calling the hook', async () => {
    const adapter = setup(); policy = () => false;
    await (await adapter.makeEditorOverlay('writer')).setRebuildReceipt!({ published: [{ collection: 'pages', id: 'home', revision: 1, deleted: false }], commit: null });
    expect((await call(publish, { retryRebuild: true })).status).toBe(403);
    expect(await (await adapter.makeEditorOverlay('writer')).getRebuildReceipt!()).not.toBeNull();
  });
});
