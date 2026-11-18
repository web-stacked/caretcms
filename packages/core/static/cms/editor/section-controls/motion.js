/**
 * Makes a layout change easy to follow. Reordering sections swaps blocks that
 * can be taller than the screen, so without help the page jumps and the
 * section you moved ends up off screen. Measure before the DOM changes, then
 * `settle()` after it:
 *  - the anchor section stays where it was on screen, so its controls stay
 *    under the pointer and a second Up/Down click works;
 *  - every section that moved slides from its old place to its new one;
 *  - the section the change was about pulses once.
 */

const DURATION = 560;
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** @param {Iterable<HTMLElement>} nodes @returns {Map<HTMLElement, number>} */
export function measureSections(nodes) {
  const tops = new Map();
  for (const node of nodes) tops.set(node, node.getBoundingClientRect().top);
  return tops;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param {{
 *   before: Map<HTMLElement, number>,
 *   nodes: HTMLElement[],
 *   anchor?: HTMLElement | null,
 *   focus?: HTMLElement | null,
 * }} options
 * @returns {number} how long the sections take to settle, in ms
 */
export function settleSections({ before, nodes, anchor, focus }) {
  if (anchor && before.has(anchor)) {
    const drift = anchor.getBoundingClientRect().top - /** @type {number} */ (before.get(anchor));
    if (Math.abs(drift) > 0.5) window.scrollBy({ top: drift, behavior: 'instant' });
  }

  if (focus) {
    focus.classList.remove('cms-section-moved');
    // Restart the pulse when the same section moves twice in a row.
    void focus.offsetWidth;
    focus.classList.add('cms-section-moved');
    focus.addEventListener('animationend', () => focus.classList.remove('cms-section-moved'), { once: true });
  }

  if (prefersReducedMotion() || typeof Element.prototype.animate !== 'function') return 0;

  const slides = [];
  for (const node of nodes) {
    const from = before.get(node);
    if (from === undefined) continue;
    const dy = from - node.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    slides.push(node.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
      { duration: DURATION, easing: EASING },
    ));
  }
  if (!slides.length) return 0;

  // The section the change was about stays in front, whether it slides or
  // holds still while the others pass behind it.
  if (focus) {
    const restore = liftAbove(focus);
    void Promise.allSettled(slides.map((slide) => slide.finished)).then(restore);
  }
  // A little past the slide, for the observer's last report on it.
  return DURATION + 120;
}

/** @param {Element | null} node @returns {string} the first solid background at or above node */
function backdropOf(node) {
  for (let el = node; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '#fff';
}

/**
 * Brings a section in front of the ones sliding past it. A see-through
 * section gets the page's background meanwhile, so they pass behind it
 * rather than through its text.
 * @param {HTMLElement} node @returns {() => void} undoes it
 */
function liftAbove(node) {
  const { position, zIndex, backgroundColor } = node.style;
  if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
  node.style.zIndex = '2';
  node.style.backgroundColor = backdropOf(node);
  return () => {
    node.style.position = position;
    node.style.zIndex = zIndex;
    node.style.backgroundColor = backgroundColor;
  };
}
