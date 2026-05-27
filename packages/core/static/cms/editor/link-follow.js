/**
 * Floating "Open page" affordance for editable elements that are or sit inside
 * an <a> with a real href. The editor's click guard blocks navigation on
 * those elements (so a click opens the inline editor, not the link); this
 * module restores a visible way to follow the link without leaving edit mode.
 */

let activeBtn = null;
let activeAnchor = null;
let hideTimer = null;

function isFollowableHref(href) {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#") return false;
  if (trimmed.startsWith("javascript:")) return false;
  return true;
}

function isExternal(href) {
  return /^https?:\/\//i.test(href);
}

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

function removeBtn() {
  if (activeBtn) {
    activeBtn.remove();
    activeBtn = null;
    activeAnchor = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function position(anchor, btn) {
  const rect = anchor.getBoundingClientRect();
  // Place above the anchor, right-aligned to its right edge so it doesn't
  // overlap the editable text on hover.
  const top = rect.top + window.scrollY - btn.offsetHeight - 8;
  const left = rect.right + window.scrollX - btn.offsetWidth;
  btn.style.top = `${Math.max(8 + window.scrollY, top)}px`;
  btn.style.left = `${Math.max(8, left)}px`;
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(removeBtn, 180);
}

function show(anchor) {
  if (activeAnchor === anchor && activeBtn) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    return;
  }
  removeBtn();

  const href = anchor.getAttribute("href");
  if (!isFollowableHref(href)) return;

  const external = isExternal(href);
  const btn = document.createElement("a");
  btn.className = "cms-link-follow";
  btn.href = href;
  btn.setAttribute("data-cms-skip-guard", "true");
  if (external) {
    btn.target = "_blank";
    btn.rel = "noopener noreferrer";
  }
  btn.innerHTML = `
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 11 L11 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
      <path d="M6 5 L11 5 L11 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
    </svg>
    <span>Open ${external ? "link" : "page"}</span>
    <em>${shortLabel(href)}</em>
  `;

  btn.addEventListener("mouseenter", () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  btn.addEventListener("mouseleave", scheduleHide);

  document.body.appendChild(btn);
  activeBtn = btn;
  activeAnchor = anchor;
  position(anchor, btn);
}

export function mountLinkFollowAffordances() {
  document.addEventListener("mouseover", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".cms-link-follow")) return;

    const editable = target.closest("[data-caret]");
    if (!editable) return;

    // Image editables have their own overlay treatment — skip.
    if (editable instanceof HTMLImageElement) return;

    const anchor = editable.matches("a") ? editable : editable.closest("a");
    if (!anchor) return;

    show(anchor);
  });

  document.addEventListener("mouseout", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".cms-link-follow")) return;

    const editable = target.closest("[data-caret]");
    const anchor = editable
      ? editable.matches("a")
        ? editable
        : editable.closest("a")
      : null;
    if (anchor === activeAnchor) scheduleHide();
  });

  const reposition = () => {
    if (activeAnchor && activeBtn) position(activeAnchor, activeBtn);
  };
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);
}
