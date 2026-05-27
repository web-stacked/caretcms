import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemAdapter } from '../../packages/core/src/runtime/storage/filesystem-adapter';

describe('FilesystemAdapter revision race', () => {
  let workdir: string;
  let adapter: FilesystemAdapter;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'alc-fs-race-'));
    adapter = new FilesystemAdapter({
      dataRoot: join(workdir, 'data'),
      metaRoot: join(workdir, 'meta'),
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('serializes concurrent bumpRevision calls without lost increments', async () => {
    const concurrency = 50;
    const bumps = await Promise.all(
      Array.from({ length: concurrency }, () => adapter.bumpRevision('pages', 'home')),
    );

    // Every bump must produce a unique sequential revision 1..N
    const sorted = [...bumps].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: concurrency }, (_, i) => i + 1));

    const final = await adapter.getRevision('pages', 'home');
    expect(final).toBe(concurrency);
  });

  it('keeps revisions for different entries independent under concurrent load', async () => {
    const tasks: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(adapter.bumpRevision('pages', 'home'));
      tasks.push(adapter.bumpRevision('pages', 'about'));
    }
    await Promise.all(tasks);

    expect(await adapter.getRevision('pages', 'home')).toBe(20);
    expect(await adapter.getRevision('pages', 'about')).toBe(20);
  });
});
