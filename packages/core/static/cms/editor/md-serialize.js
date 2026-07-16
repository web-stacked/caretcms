/**
 * DOM → markdown block serializer (browser side).
 *
 * NOTE: `serializeBlock` and its helpers below are a HAND MIRROR of
 * src/markdown/serialize.ts (this file ships as raw unbundled JS and can't
 * import it). tests/unit/md-serialize-parity.test.ts runs both implementations
 * over a shared corpus of node trees and fails CI on any divergence.
 *
 * `domToSNodes` is the only DOM-touching part: it converts a block element's
 * child nodes into the same minimal tree the TS serializer is tested against,
 * so the serialization logic itself stays DOM-free and parity-checkable.
 *
 * @typedef {{ type: 'text', value: string }
 *   | { type: 'element', tag: string, attrs: Record<string,string>, children: SNode[] }} SNode
 */

export class SerializeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SerializeError';
  }
}

const INLINE_ESCAPE_RE = /[\\`*_[\]<&>~]/g;

/**
 * @param {string} value
 * @returns {string}
 */
function escapeText(value) {
  // Collapse ASCII whitespace runs to a single space FIRST — matches HTML
  // rendering and makes <br> the serializer's only newline source. nbsp is
  // deliberately NOT collapsed.
  return value.replace(/[ \t\r\n]+/g, ' ').replace(INLINE_ESCAPE_RE, (c) => `\\${c}`);
}

/**
 * @param {string} md
 * @returns {string}
 */
function escapeLineStart(md) {
  const ws = /^\s*/.exec(md)[0];
  const rest = md.slice(ws.length);

  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(rest);
  if (ordered) {
    return `${ws}${ordered[1]}\\${ordered[2]}${rest.slice(ordered[1].length + 1)}`;
  }

  // Dash/equals runs cover setext underlines (ONE-or-more `-`/`=`) and
  // thematic breaks with interior spaces; `*`/`_` variants are already
  // neutralized by escapeText.
  const marker =
    /^(?:#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|-(?:[ \t]*-)*[ \t]*$|=(?:[ \t]*=)*[ \t]*$|~{3,}|`{3,}|\|)/.test(
      rest,
    );
  return marker ? `${ws}\\${rest}` : md;
}

/**
 * @param {Extract<SNode, { type: 'element' }>} node
 * @returns {string}
 */
function tagOf(node) {
  const t = node.tag.toLowerCase();
  if (t === 'b') return 'strong';
  if (t === 'i') return 'em';
  return t;
}

/**
 * @param {readonly SNode[]} nodes
 * @returns {string}
 */
function rawText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.tag.toLowerCase() === 'br') out += ' ';
    else out += rawText(n.children);
  }
  return out;
}

/**
 * @param {string} content
 * @returns {string}
 */
function codeSpan(content) {
  if (content === '') return '``';
  const runs = content.match(/`+/g) ?? [];
  let fenceLen = 1;
  while (runs.some((r) => r.length === fenceLen)) fenceLen++;
  const fence = '`'.repeat(fenceLen);
  const needsPad =
    content.startsWith('`') ||
    content.endsWith('`') ||
    (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '');
  return needsPad ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

/**
 * @param {string} href
 * @returns {string}
 */
function linkDestination(href) {
  // Control chars (incl. \n, \r) have no representable escape in either
  // destination form — hard-fail rather than inject markdown structure.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(href)) {
    throw new SerializeError('control character in link destination');
  }
  if (/^[^\s<>()\\]*$/.test(href)) return href;
  return `<${href.replace(/([<>\\])/g, '\\$1')}>`;
}

/**
 * @param {Record<string,string>} a
 * @param {Record<string,string>} b
 * @returns {boolean}
 */
function sameAttrs(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * @param {readonly SNode[]} nodes
 * @returns {SNode[]}
 */
function mergeAdjacent(nodes) {
  /** @type {SNode[]} */
  const out = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'text' && prev?.type === 'text') {
      prev.value += node.value;
      continue;
    }
    if (
      node.type === 'element' &&
      prev?.type === 'element' &&
      tagOf(prev) === tagOf(node) &&
      tagOf(node) !== 'br' &&
      sameAttrs(prev.attrs, node.attrs)
    ) {
      prev.children = [...prev.children, ...node.children];
      continue;
    }
    out.push(node.type === 'text' ? { ...node } : { ...node, children: [...node.children] });
  }
  return out;
}

/**
 * @param {readonly SNode[]} nodes
 * @param {number} i
 * @returns {string}
 */
function nextLeadChar(nodes, i) {
  const next = nodes[i + 1];
  if (!next) return '';
  if (next.type === 'text') return next.value[0] ?? '';
  return '<';
}

/**
 * @param {readonly SNode[]} nodes
 * @param {number} i
 * @param {'*' | '_' | null} prevMarker
 * @returns {'*' | '_'}
 */
function emphasisMarker(nodes, i, prevMarker) {
  if (prevMarker === null) return '*';
  const flipped = prevMarker === '*' ? '_' : '*';
  if (flipped === '_' && /[A-Za-z0-9_]/.test(nextLeadChar(nodes, i))) return '*';
  return flipped;
}

/**
 * @param {readonly SNode[]} rawNodes
 * @param {{ allowBreak: boolean }} opts
 * @returns {string}
 */
function serializeChildren(rawNodes, opts) {
  const nodes = mergeAdjacent(rawNodes);
  let out = '';
  /** @type {'*' | '_' | null} */
  let prevMarker = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'text') {
      out += escapeText(node.value);
      prevMarker = null;
      continue;
    }
    const tag = tagOf(node);
    switch (tag) {
      case 'strong': {
        const inner = serializeChildren(node.children, opts);
        if (inner === '') {
          prevMarker = null;
          break;
        }
        const m = emphasisMarker(nodes, i, prevMarker);
        out += `${m}${m}${inner}${m}${m}`;
        prevMarker = m;
        break;
      }
      case 'em': {
        const inner = serializeChildren(node.children, opts);
        if (inner === '') {
          prevMarker = null;
          break;
        }
        const m = emphasisMarker(nodes, i, prevMarker);
        out += `${m}${inner}${m}`;
        prevMarker = m;
        break;
      }
      case 'code': {
        prevMarker = null;
        out += codeSpan(rawText(node.children));
        break;
      }
      case 'a': {
        const href = node.attrs.href;
        if (href === undefined) throw new SerializeError('<a> without href');
        prevMarker = null;
        const inner = serializeChildren(node.children, opts);
        out += `[${inner}](${linkDestination(href)})`;
        break;
      }
      case 'br': {
        if (!opts.allowBreak) {
          throw new SerializeError('hard break not allowed in a nested block');
        }
        prevMarker = null;
        out += '\\\n';
        break;
      }
      default:
        throw new SerializeError(`unsupported inline element <${node.tag}>`);
    }
  }
  return out;
}

/**
 * Serialize the inline children of one block to markdown source.
 * @param {readonly SNode[]} children
 * @param {{ block: 'heading', level: number } | { block: 'paragraph', nested: boolean }} ctx
 * @returns {string}
 */
export function serializeBlock(children, ctx) {
  if (ctx.block === 'heading') {
    if (!Number.isInteger(ctx.level) || ctx.level < 1 || ctx.level > 6) {
      throw new SerializeError(`invalid heading level: ${ctx.level}`);
    }
    const inline = serializeChildren(children, { allowBreak: false });
    return `${'#'.repeat(ctx.level)} ${inline}`;
  }
  const inline = serializeChildren(children, { allowBreak: !ctx.nested });
  // Every line (hard breaks are the only line boundary) must be prevented
  // from opening a new block — CommonMark's block scanner runs before inline
  // parsing sees the trailing backslash.
  return inline.split('\\\n').map(escapeLineStart).join('\\\n');
}

/**
 * Convert a block element's DOM children into the minimal SNode tree the
 * serializer consumes. Only `href` is carried (the sole attribute the closed
 * set represents); every other element passes through so the serializer can
 * reject anything the sanitizer failed to strip.
 * @param {Node} element
 * @returns {SNode[]}
 */
export function domToSNodes(element) {
  /** @type {SNode[]} */
  const out = [];
  for (const child of element.childNodes) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      out.push({ type: 'text', value: /** @type {Text} */ (child).data });
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      const elem = /** @type {Element} */ (child);
      /** @type {Record<string,string>} */
      const attrs = {};
      const href = elem.getAttribute('href');
      if (href !== null) attrs.href = href;
      out.push({
        type: 'element',
        tag: elem.tagName.toLowerCase(),
        attrs,
        children: domToSNodes(elem),
      });
    }
  }
  return out;
}
