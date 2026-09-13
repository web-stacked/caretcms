/** Structural editing stays within a run of complete top-level paragraphs. */
import { fnv1a32, type MdSrc } from './contracts.js';
import { serializeBlock } from './serialize.js';
import { htmlToSNodes } from './html-to-snodes.js';
import { sanitizeHtml } from '../runtime/sanitize-html.js';

export interface ParagraphSource { blockPath: string; src: MdSrc; html: string }

export function paragraphSourcesMatch(body: string, sources: readonly ParagraphSource[]): boolean {
  return sources.every(({ src, blockPath }, index) => {
    if (!/^\d+$/.test(blockPath) || src.end > body.length || fnv1a32(body.slice(src.start, src.end)) !== src.hash) return false;
    if (index > 0) {
      const previous = sources[index - 1];
      if (Number(blockPath) !== Number(previous.blockPath) + 1 || src.start <= previous.src.end ||
          !/^\n[ \t]*\n[\s]*$/.test(body.slice(previous.src.end, src.start))) return false;
    }
    // Require whole paragraphs, including a blank line on each available side.
    const before = body.slice(0, src.start);
    const after = body.slice(src.end);
    if (before && !/\n[ \t]*\n$/.test(before)) return false;
    if (after && !/^\n[ \t]*\n/.test(after)) return false;
    const lines = body.slice(src.start, src.end).split('\n');
    // Conservative: unusual Markdown stays editable through the single-block
    // path. Never restructure headings, lists, quotes, definitions or tables.
    if (lines.some(line => !line.trim() || /^(?:[ \t]|#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}|~{3,}|<|\[.*\]:|[-=]+\s*$)/.test(line) || line.includes('|'))) return false;
    // Blank lines inside fenced code and HTML must not create prose regions.
    let fence: string | null = null;
    let html = false;
    for (const line of before.split('\n')) {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
      }
      if (!fence && /^ {0,3}<(?:script|style|pre|textarea|!--)(?:\s|>|$)/i.test(line)) html = true;
      if (html && /(?:<\/(?:script|style|pre|textarea)>|-->)/i.test(line)) html = false;
    }
    return !fence && !html;
  });
}

export function serializeParagraphs(
  body: string,
  sources: readonly ParagraphSource[],
  paragraphs: readonly string[],
  allowedClasses?: Record<string, readonly string[]>,
): { md: string; paragraphs: string[]; src: MdSrc } {
  const clean = paragraphs.map(html => sanitizeHtml(html, { allowedClasses }));
  const md = clean.map(html => {
    // An unchanged paragraph keeps its original Markdown spelling. The HTML
    // baseline is only a preservation hint; it cannot supply new source text.
    const original = sources.find(source => html === sanitizeHtml(source.html, { allowedClasses }));
    if (original) return body.slice(original.src.start, original.src.end);
    return html === '' || /^<br\s*\/?\s*>$/i.test(html) ? '' : serializeBlock(htmlToSNodes(html), { block: 'paragraph', nested: false });
  }).filter(text => text.trim() !== '').join('\n\n');
  const start = sources[0].src.start;
  const end = sources[sources.length - 1].src.end;
  return { md, paragraphs: clean, src: { start, end, hash: fnv1a32(body.slice(start, end)) } };
}
