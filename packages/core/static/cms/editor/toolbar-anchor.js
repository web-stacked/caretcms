/**
 * Keep the toolbar's buttons where the pointer left them. The bar is centered
 * once, then holds its right edge: a longer status word or an extra button
 * grows it leftward, so Publish, Studio and Sign out stay put. It moves only
 * when the drawer would cover it, by as little as clears it, and re-centers
 * when the window is resized. Phones lay the bar out full width in CSS.
 */

const GAP = 12;
const PHONE = '(max-width: 768px)';

/** @typedef {{ side: 'left' | 'right', width: number } | null} DrawerLayout */

/** @param {HTMLElement} toolbar */
export function anchorToolbar(toolbar) {
  /** Distance from the viewport's right edge to the bar's, chosen when centering. @type {number | null} */
  let preferredRight = null;
  /** @type {DrawerLayout} */
  let drawer = null;

  function place() {
    if (window.matchMedia(PHONE).matches) {
      toolbar.classList.remove('cms-toolbar-anchored');
      return;
    }
    const viewport = document.documentElement.clientWidth;
    const width = toolbar.offsetWidth;
    if (preferredRight === null) preferredRight = Math.max(GAP, (viewport - width) / 2);
    const minLeft = GAP + (drawer?.side === 'left' ? drawer.width : 0);
    const minRight = GAP + (drawer?.side === 'right' ? drawer.width : 0);
    let right = Math.max(preferredRight, minRight);
    if (viewport - right - width < minLeft) right = Math.max(minRight, viewport - minLeft - width);
    toolbar.style.setProperty('--cms-toolbar-right', `${Math.round(right)}px`);
    toolbar.classList.add('cms-toolbar-anchored');
  }

  new ResizeObserver(place).observe(toolbar);
  window.addEventListener('resize', () => {
    preferredRight = null;
    place();
  });
  place();

  return {
    /** @param {DrawerLayout} layout */
    setDrawer(layout) {
      drawer = layout;
      place();
    },
  };
}
