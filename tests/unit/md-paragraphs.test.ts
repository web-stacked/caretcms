import { describe, expect, it } from 'vitest';
import { paragraphSourcesMatch, serializeParagraphs } from '../../packages/core/src/markdown/paragraphs';
import { fnv1a32 } from '../../packages/core/src/markdown/contracts';
import { spliceBodyBlocks } from '../../packages/core/src/markdown/splice';

function source(body: string, text: string, blockPath = '0', html = text) {
  const start = body.indexOf(text);
  return { blockPath, html, src: { start, end: start + text.length, hash: fnv1a32(text) } };
}

describe('paragraph structure', () => {
  it('splits, merges and deletes without moving frontmatter or neighboring blocks', () => {
    const body = 'First paragraph.\n\nSecond paragraph.\n\n> Keep the quote.';
    const sources = [source(body, 'First paragraph.'), source(body, 'Second paragraph.', '1')];
    expect(paragraphSourcesMatch(body, sources)).toBe(true);
    for (const paragraphs of [['First', 'paragraph.', 'Second paragraph.'], ['Joined paragraphs.'], []]) {
      const group = serializeParagraphs(body, sources, paragraphs);
      const file = '---\ntitle: Unchanged\n---\n\n' + body + '\n';
      const result = spliceBodyBlocks(file, [group]);
      expect(result).toEqual({ ok: true, content: '---\ntitle: Unchanged\n---\n\n' + paragraphs.join('\n\n') + '\n\n> Keep the quote.\n' });
    }
  });

  it('preserves original Markdown for untouched paragraphs and escapes new block markers', () => {
    const body = 'An __original__ paragraph.\n\nSecond paragraph.';
    const sources = [source(body, 'An __original__ paragraph.', '0', 'An <strong>original</strong> paragraph.'), source(body, 'Second paragraph.', '1')];
    const group = serializeParagraphs(body, sources, [sources[0].html, '# Literal heading']);
    expect(group.md).toBe('An __original__ paragraph.\n\n\\# Literal heading');
    expect(spliceBodyBlocks(body.replace('paragraph.\n', 'paragraph!\n'), [group]).ok).toBe(false);
  });

  it.each(['# Heading', '> Quote', '- List', '    Code', 'Title\n===', 'a | b', '[ref]: /url', '<div>HTML</div>'])('rejects structural island %s', text => {
    expect(paragraphSourcesMatch(text, [source(text, text)])).toBe(false);
  });

  it('rejects ranges crossing an island, partial paragraphs, nested paths, reordered and stale sources', () => {
    const body = 'First.\n\n> Quote.\n\nSecond.';
    const first = source(body, 'First.');
    const last = source(body, 'Second.', '2');
    expect(paragraphSourcesMatch(body, [first, last])).toBe(false);
    expect(paragraphSourcesMatch(body, [last, first])).toBe(false);
    expect(paragraphSourcesMatch(body, [{ ...first, blockPath: '0.0' }])).toBe(false);
    expect(paragraphSourcesMatch(body, [source(body, 'First')])).toBe(false);
    expect(paragraphSourcesMatch(body + 'changed', [last])).toBe(false);
    expect(paragraphSourcesMatch('```\n\nProse looking code.\n\n```', [source('```\n\nProse looking code.\n\n```', 'Prose looking code.')])).toBe(false);
  });
});
