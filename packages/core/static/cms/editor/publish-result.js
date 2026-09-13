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

/**
 * Turn the publish API's mutually exclusive outcomes into one toolbar action.
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
      status: { state: 'error', text: 'Publish needs recovery' },
      toast: {
        kind: 'error',
        message: `Finished ${published.length} change(s); ${failed.length} need recovery. Some content may already be published. Retry Publish after checking storage. Drafts are kept.`,
      },
    };
  }

  if (conflicts.length > 0) {
    const labels = conflicts.map(entry => {
      const collection = typeof entry.collection === 'string' ? entry.collection : 'unknown';
      const id = typeof entry.id === 'string' ? entry.id : 'unknown';
      return `${collection}/${id}`;
    }).join(', ');
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: 'Draft conflict' },
      toast: {
        kind: 'error',
        message: `Drafts kept for ${labels}. Published content changed, or the draft predates conflict tracking. Copy your edits before using Discard (which removes all your drafts), then reload and reapply them.`,
      },
    };
  }

  if (rebuild.triggered === true && rebuild.ok === false) {
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: 'Published, deploy failed' },
      toast: {
        kind: 'error',
        message: 'Changes are published, but the deploy webhook failed. Check your CI settings.',
      },
    };
  }

  const rebuildTriggered = rebuild.triggered === true;
  return {
    completed: true,
    reload: true,
    retryAvailable,
    status: null,
    toast: {
      kind: 'success',
      message: rebuildTriggered
        ? published.length > 0
          ? `Published ${published.length} change(s) — rebuild started`
          : 'Your site is rebuilding'
        : published.length > 0
          ? `Published ${published.length} change(s) — rebuild and deploy to update visitors`
          : 'Already up to date',
    },
  };
}
