import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemAdapter } from '../../packages/core/src/runtime/storage/filesystem-adapter';

/**
 * The filesystem adapter must fail fast with an actionable message when
 * constructed on workerd — including Astro 6's dev server, which runs on
 * workerd too — instead of silently no-op'ing reads and throwing cryptic
 * errors on writes.
 */
describe('FilesystemAdapter runtime guard', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  it('throws an actionable error when running on workerd', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    });

    expect(() => new FilesystemAdapter()).toThrowError(/not available on Cloudflare Workers/);
    expect(() => new FilesystemAdapter()).toThrowError(/@caretcms\/cloudflare/);
  });

  it('constructs normally on a Node runtime', () => {
    // vitest runs on Node: navigator.userAgent is not "Cloudflare-Workers".
    expect(() => new FilesystemAdapter({ dataRoot: '/tmp/x', metaRoot: '/tmp/y' })).not.toThrow();
  });
});
