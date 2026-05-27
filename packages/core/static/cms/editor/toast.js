export function createToast() {
  let activeToast = null;

  return function showToast(message, type) {
    if (activeToast) {
      activeToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = `cms-toast cms-toast-${type}`;

    const iconSvg =
      type === 'success'
        ? '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
        : '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

    toast.innerHTML = iconSvg + `<span>${message}</span>`;
    document.body.appendChild(toast);
    activeToast = toast;

    setTimeout(() => {
      toast.classList.add('cms-toast-out');
      setTimeout(() => {
        toast.remove();
        if (activeToast === toast) activeToast = null;
      }, 300);
    }, 2500);
  };
}
