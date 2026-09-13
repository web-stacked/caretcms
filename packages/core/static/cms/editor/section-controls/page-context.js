/** @typedef {{ collection: string, id: string }} PageContext */
/** @typedef {{ collection: string | null, id: string | null, field: string }} ParsedCaretBinding */

/**
 * @param {(value: string) => ParsedCaretBinding | null} parseCaretAttr
 * @param {Element[]} sectionNodes
 * @returns {PageContext | null}
 */
export function getPageContext(parseCaretAttr, sectionNodes) {
  for (const sectionNode of sectionNodes) {
    if (!(sectionNode instanceof Element)) continue;
    const collection = sectionNode.getAttribute('data-caret-collection');
    const id = sectionNode.getAttribute('data-caret-entry-id');
    if (collection && id) {
      return { collection, id };
    }
  }

  for (const sectionNode of sectionNodes) {
    if (!(sectionNode instanceof Element)) continue;
    const marker = sectionNode.querySelector('[data-caret]');
    if (!marker) continue;

    const attr = marker.getAttribute('data-caret');
    if (!attr) continue;

    const parsed = parseCaretAttr(attr);
    if (!parsed) continue;
    if (parsed.collection !== 'pages') continue;
    if (!parsed.id) continue;

    return {
      collection: parsed.collection,
      id: parsed.id,
    };
  }

  if (window.location.pathname === '/') {
    return { collection: 'pages', id: 'home' };
  }

  return null;
}
