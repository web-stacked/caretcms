/** @typedef {'idle' | 'saving' | 'error'} ToolbarStatusState */
/** @typedef {'success' | 'error'} ToastKind */
/**
 * @typedef {object} PublishPresentation
 * @property {boolean} completed
 * @property {boolean} reload
 * @property {boolean} retryAvailable
 * @property {{ state: ToolbarStatusState, text: string } | null} status
 * @property {{ kind: ToastKind, message: string }} toast
 */

/** @param {unknown} value */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
function entries(value) {
  return Array.isArray(value) ? value.map(record) : [];
}

/** @param {number} count */
function changes(count) {
  return count === 1 ? '1 change' : `${count} changes`;
}

/** Entry names for a message: “Mara Ellison”, “About” and 2 more. @param {Record<string, unknown>[]} list */
function names(list) {
  const titles = list.map(entry => typeof entry.title === 'string' && entry.title ? `“${entry.title}”` : 'an entry');
  const text = titles.length <= 2 ? titles.join(' and ') : `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Turn the publish API's mutually exclusive outcomes into one toolbar action,
 * worded for editors: what happened, when visitors see it, what to do next.
 * Keeping this pure makes recovery/conflict/deploy wording testable without DOM.
 *
 * @param {unknown} input
 * @returns {PublishPresentation}
 */
export function presentPublishResult(input) {
  const data = record(input);
  const published = entries(data.published);
  const conflicts = entries(data.conflicts);
  const failed = entries(data.failed);
  const rebuild = record(data.rebuild);
  const retryAvailable = data.retryAvailable === true;

  if (failed.length > 0) {
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: 'Publish didn’t finish' },
      toast: {
        kind: 'error',
        message: `${names(failed)} couldn’t be published${published.length > 0 ? ` (${changes(published.length)} went through)` : ''}. Your drafts are kept. Try Publish again.`,
      },
    };
  }

  if (conflicts.length > 0) {
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: 'Not published' },
      toast: {
        kind: 'error',
        message: `${names(conflicts)} changed on the site since you started editing, so ${conflicts.length === 1 ? 'it wasn’t' : 'they weren’t'} published. Your draft is kept: copy your edits, reload the page, and make them again.`,
      },
    };
  }

  if (rebuild.triggered === true && rebuild.ok === false) {
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: 'Published, site not updated' },
      toast: {
        kind: 'error',
        message: 'Your changes are published, but the site couldn’t start updating. Use Retry update, or ask your developer to check how the site is deployed.',
      },
    };
  }

  if (data.journalRetryAvailable === true) {
    return {
      completed: true, reload: true, retryAvailable,
      status: { state: 'error', text: 'Published, Git history pending' },
      toast: { kind: 'error', message: 'Your changes are published. Their Git history is still pending; use Retry Git history, or ask your developer.' },
    };
  }

  const rebuildTriggered = rebuild.triggered === true;
  const count = changes(published.length);
  const them = published.length === 1 ? 'it' : 'them';
  return {
    completed: true,
    reload: true,
    retryAvailable,
    status: null,
    toast: {
      kind: 'success',
      message: published.length === 0
        ? rebuildTriggered ? 'The site is updating' : 'Nothing to publish'
        : rebuildTriggered
          ? `Published ${count}. The site is updating; visitors see ${them} in a few minutes.`
          : data.needsRebuild === true
            ? `Published ${count}. Visitors see ${them} the next time the site updates.`
            : `Published ${count}. Visitors see ${them} now.`,
    },
  };
}
