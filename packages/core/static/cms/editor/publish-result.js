import { t } from './i18n.js';

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
  return count === 1 ? t('editor.publish.changesOne') : t('editor.publish.changesOther', { count });
}

/** Entry names for a message: “Mara Ellison”, “About” and 2 more. @param {Record<string, unknown>[]} list */
function names(list) {
  const titles = list.map(entry => typeof entry.title === 'string' && entry.title
    ? t('editor.publish.entryNamed', { title: entry.title })
    : t('editor.publish.entryUnnamed'));
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return t('editor.publish.namesTwo', { first: titles[0], second: titles[1] });
  return t('editor.publish.namesMore', { first: titles[0], second: titles[1], count: titles.length - 2 });
}

/** A message may start with an entry's name ("an entry"). @param {string} text */
function sentence(text) {
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
      status: { state: 'error', text: t('editor.publish.unfinished') },
      toast: {
        kind: 'error',
        message: sentence(published.length > 0
          ? t('editor.publish.failedPartial', {
            names: names(failed),
            done: t(published.length === 1 ? 'editor.publish.wentThroughOne' : 'editor.publish.wentThroughOther', { count: published.length }),
          })
          : t('editor.publish.failed', { names: names(failed) })),
      },
    };
  }

  if (conflicts.length > 0) {
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: t('editor.publish.notPublished') },
      toast: {
        kind: 'error',
        message: sentence(t(conflicts.length === 1 ? 'editor.publish.conflictOne' : 'editor.publish.conflictOther', { names: names(conflicts) })),
      },
    };
  }

  if (rebuild.triggered === true && rebuild.ok === false) {
    return {
      completed: false,
      reload: false,
      retryAvailable,
      status: { state: 'error', text: t('editor.publish.notUpdated') },
      toast: {
        kind: 'error',
        message: t('editor.publish.rebuildFailed'),
      },
    };
  }

  // A pending Git history record is the developer's to resolve (dev toolbar,
  // server log); the editor's changes are published either way.
  const rebuildTriggered = rebuild.triggered === true;
  const count = changes(published.length);
  const one = published.length === 1;
  return {
    completed: true,
    reload: true,
    retryAvailable,
    status: null,
    toast: {
      kind: 'success',
      message: published.length === 0
        ? rebuildTriggered ? t('editor.publish.siteUpdating') : t('editor.publish.nothing')
        : rebuildTriggered
          ? t(one ? 'editor.publish.updatingOne' : 'editor.publish.updatingOther', { changes: count })
          : data.needsRebuild === true
            ? t(one ? 'editor.publish.nextUpdateOne' : 'editor.publish.nextUpdateOther', { changes: count })
            : t(one ? 'editor.publish.nowOne' : 'editor.publish.nowOther', { changes: count }),
    },
  };
}
