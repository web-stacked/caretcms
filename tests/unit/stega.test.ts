import { describe, expect, it } from 'vitest';
import {
  hasStega,
  stegaClean,
  stegaCombine,
  stegaDecode,
  stegaSplit,
} from '../../packages/core/src/runtime/stega';

const KEY = { collection: 'pages', id: 'home', field: 'hero_title' };

describe('stega content source maps', () => {
  it('round-trips a payload hidden inside a string', () => {
    const encoded = stegaCombine('Professional Websites', KEY);
    expect(stegaDecode(encoded)).toEqual(KEY);
  });

  it('looks identical to the original when cleaned/printed', () => {
    const encoded = stegaCombine('Professional Websites', KEY);
    // The visible text is unchanged...
    expect(stegaClean(encoded)).toBe('Professional Websites');
    // ...even though the raw string is longer (carries invisible metadata).
    expect(encoded.length).toBeGreaterThan('Professional Websites'.length);
    expect(hasStega(encoded)).toBe(true);
  });

  it('SURVIVES flowing through props, components, and loops', () => {
    // Encode once, as a loader would.
    const value = stegaCombine('Quick Delivery', { ...KEY, field: 'pill_1' });

    // Simulate the value being passed as a prop into a component, wrapped in
    // markup, and produced inside a .map() — i.e. string interpolation. The
    // hidden key must still be recoverable from the rendered text node.
    const renderedHtml = [value].map((v) => `<span class="pill">${v}</span>`).join('');
    const domTextNode = renderedHtml.replace(/<[^>]+>/g, ''); // what the browser "sees"

    expect(stegaClean(domTextNode)).toBe('Quick Delivery');
    expect(stegaDecode(domTextNode)).toEqual({ ...KEY, field: 'pill_1' });
  });

  it('stegaSplit returns cleaned text and payload together', () => {
    const encoded = stegaCombine('Direct communication.', KEY);
    expect(stegaSplit(encoded)).toEqual({
      cleaned: 'Direct communication.',
      payload: KEY,
    });
  });

  it('is a no-op on plain (unencoded) strings', () => {
    expect(stegaDecode('just text')).toBeUndefined();
    expect(stegaClean('just text')).toBe('just text');
    expect(hasStega('just text')).toBe(false);
  });

  it('preserves non-ASCII visible content and payloads', () => {
    const encoded = stegaCombine('10+ Years — Café ☕', { field: 'naïve_key' });
    expect(stegaClean(encoded)).toBe('10+ Years — Café ☕');
    expect(stegaDecode(encoded)).toEqual({ field: 'naïve_key' });
  });

  it('cleaning fully restores the original byte-for-byte (published output)', () => {
    const original = 'See what I have built for other clients.';
    const encoded = stegaCombine(original, KEY);
    expect(stegaClean(encoded)).toBe(original);
  });
});
