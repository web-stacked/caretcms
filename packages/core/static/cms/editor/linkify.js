/** @param {string} s */
export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {string} text */
export function clientLinkify(text) {
  if (!text) return '';

  const MD = /\[([^\]]+)\]\(([^)]+)\)/;
  const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const PHONE = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
  const URL_PAT =
    /\bhttps?:\/\/[^\s<>"')\]]+|\b[\w.-]+\.(?:com|org|net|io|co|dev|app|store|shop|jewelry|diamonds|gold)(?:\/[^\s<>"')\]]*)?/;

  const combined = new RegExp(
    `(${MD.source})|(${EMAIL.source})|(${PHONE.source})|(${URL_PAT.source})`,
    'gi',
  );

  let result = '';
  let lastIndex = 0;

  for (const m of text.matchAll(combined)) {
    const start = m.index;
    result += escapeHtml(text.slice(lastIndex, start));

    const [full, mdFull, mdText, mdUrl, email, phone] = m;

    if (mdFull) {
      const href = /^https?:\/\//i.test(mdUrl)
        ? mdUrl
        : /^[/]|^mailto:|^tel:/.test(mdUrl)
          ? mdUrl
          : 'https://' + mdUrl;
      const ext = /^https?:\/\//i.test(href);
      result += `<a href="${escapeHtml(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''} class="text-secondary hover:underline">${escapeHtml(mdText)}</a>`;
    } else if (email) {
      result += `<a href="mailto:${escapeHtml(email)}" class="text-secondary hover:underline">${escapeHtml(email)}</a>`;
    } else if (phone) {
      const digits = full.replace(/\D/g, '');
      result += `<a href="tel:${digits}" class="text-secondary hover:underline">${escapeHtml(full)}</a>`;
    } else {
      const href = /^https?:\/\//i.test(full) ? full : 'https://' + full;
      result += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="text-secondary hover:underline">${escapeHtml(full)}</a>`;
    }

    lastIndex = start + full.length;
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}
