/**
 * Floating "Open page" affordance for editable elements that are or sit inside
 * an <a> with a real href. The editor's click guard blocks navigation on
 * those elements (so a click opens the inline editor, not the link); this
 * module restores a visible way to follow the link without leaving edit mode.
 */

/** @type {HTMLAnchorElement | null} */
let activeBtn = null;
/** @type {HTMLAnchorElement | null} */
let activeAnchor = null;
/** @type {number | null} */
let hideTimer = null;

/** @param {string | null} href @returns {boolean} */
function isFollowableHref(href) {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#") return false;
  try {
    const url = new URL(trimmed, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/** @param {string} href @returns {boolean} */
function isExternal(href) {
  return /^https?:\/\//i.test(href);
}

/** @param {string} href @returns {string} */
function shortLabel(href) {
  if (isExternal(href)) {
    try {
      return new URL(href).host.replace(/^www\./, "");
    } catch {
      return "link";
    }
  }
  return href;
}

function cancelHide() {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function removeBtn() {
  if (activeBtn) {
    activeBtn.remove();
    activeBtn = null;
    activeAnchor = null;
  }
  cancelHide();
}

/** @param {HTMLAnchorElement} anchor @param {HTMLAnchorElement} btn */
function position(anchor, btn) {
  if (!anchor.isConnected || !btn.isConnected) {
    removeBtn();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    removeBtn();
    return;
  }

  const gap = 8;
  const margin = 8;
  const width = btn.offsetWidth;
  const height = btn.offsetHeight;
  const candidates = [
    { left: rect.right + gap, top: rect.top + (rect.height - height) / 2 },
    { left: rect.left, top: rect.bottom + gap },
    { left: rect.left, top: rect.top - height - gap },
    { left: rect.left - width - gap, top: rect.top + (rect.height - height) / 2 },
  ];
  const otherEditables = Array.from(document.querySelectorAll('[data-caret]'))
    .filter((el) => !anchor.contains(el))
    .map((el) => el.getBoundingClientRect());

  /** @param {{ left: number, top: number }} candidate */
  function overlapsEditable(candidate) {
    const box = {
      left: candidate.left,
      top: candidate.top,
      right: candidate.left + width,
      bottom: candidate.top + height,
    };
    return otherEditables.some((other) =>
      box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
    );
  }

  const placed = candidates.find((candidate) =>
    candidate.left >= margin
    && candidate.top >= margin
    && candidate.left + width <= window.innerWidth - margin
    && candidate.top + height <= window.innerHeight - margin
    && !overlapsEditable(candidate)
  );

  btn.classList.toggle('cms-link-follow-compact', !placed);
  const fallback = {
    left: Math.min(window.innerWidth - width - margin, Math.max(margin, rect.right - width)),
    top: Math.min(window.innerHeight - height - margin, Math.max(margin, rect.top)),
  };
  const target = placed || fallback;
  btn.style.top = `${target.top}px`;
  btn.style.left = `${target.left}px`;
}

function scheduleHide() {
  cancelHide();
  hideTimer = window.setTimeout(removeBtn, 180);
}

/** @param {HTMLAnchorElement} anchor */
function show(anchor) {
  if (activeAnchor === anchor && activeBtn) {
    cancelHide();
    return;
  }
  removeBtn();

  const href = anchor.getAttribute("href");
  if (!isFollowableHref(href) || typeof href !== 'string') return;

  const external = isExternal(href);
  const btn = document.createElement("a");
  btn.className = "cms-link-follow";
  btn.href = href;
  btn.setAttribute("data-cms-skip-guard", "true");
  if (external) {
    btn.target = "_blank";
    btn.rel = "noopener noreferrer";
  }
  btn.setAttribute('aria-label', `Open ${external ? "link" : "page"}: ${shortLabel(href)}`);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<path d="M5 11 L11 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M6 5 L11 5 L11 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>';
  const label = document.createElement('span');
  label.textContent = `Open ${external ? "link" : "page"}`;
  const destination = document.createElement('em');
  destination.textContent = shortLabel(href);
  btn.append(icon, label, destination);

  btn.addEventListener("mouseenter", () => {
    cancelHide();
  });
  btn.addEventListener("mouseleave", scheduleHide);

  document.body.appendChild(btn);
  activeBtn = btn;
  activeAnchor = anchor;
  position(anchor, btn);
}

export function mountLinkFollowAffordances() {
  /** @param {Element} target @returns {Element | null} */
  function editableFromTarget(target) {
    const direct = target.closest('[data-caret]');
    if (direct) return direct;
    return target.closest('.cms-img-wrapper')?.querySelector('img[data-caret]') || null;
  }

  /** @param {Element} editable @returns {HTMLAnchorElement | null} */
  function anchorFromEditable(editable) {
    return editable instanceof HTMLAnchorElement ? editable : editable.closest('a');
  }

  document.addEventListener("mouseover", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".cms-link-follow")) return;

    const editable = editableFromTarget(target);
    if (!editable) return;

    const anchor = anchorFromEditable(editable);
    if (!anchor) return;

    show(anchor);
  });

  document.addEventListener("mouseout", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".cms-link-follow")) return;

    const editable = editableFromTarget(target);
    const anchor = editable ? anchorFromEditable(editable) : null;
    if (anchor === activeAnchor) scheduleHide();
  });

  const reposition = () => {
    if (activeAnchor && activeBtn) position(activeAnchor, activeBtn);
  };
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);

  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.cms-link-follow')) {
      cancelHide();
      return;
    }
    const editable = editableFromTarget(target);
    const anchor = editable ? anchorFromEditable(editable) : null;
    if (anchor) show(anchor);
  });
  document.addEventListener('focusout', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (editableFromTarget(target)) scheduleHide();
  });
}
