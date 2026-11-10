import {
  generateSectionId,
  normalizeSpacingY,
  spacingName,
} from './utils.js';
import { t } from '../i18n.js';

/** @typedef {import('./model.js').Section} Section */
/** @typedef {{ sectionKey?: unknown, spacingY?: unknown }} MutationPayload */

/**
 * @param {{
 *   sections: Section[],
 *   action: string,
 *   sectionId: string,
 *   payload?: MutationPayload,
 *   applySpacing: (sectionId: string, spacingY: string | undefined) => boolean,
 *   kinds: Map<string, string>,
 * }} options
 * @returns {{ ok: true, message: string, sections: Section[] } | { ok: false, message: string }}
 */
export function mutateSections({
  sections,
  action,
  sectionId,
  payload,
  applySpacing,
  kinds,
}) {
  const index = sections.findIndex((section) => section.id === sectionId);
  if (index === -1) return { ok: false, message: t('editor.sections.notFound') };

  if (action === 'up') {
    if (index === 0) return { ok: false, message: t('editor.sections.alreadyFirst') };
    const next = [...sections];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    return { ok: true, message: t('editor.sections.movedUp'), sections: next };
  }

  if (action === 'down') {
    if (index === sections.length - 1) {
      return { ok: false, message: t('editor.sections.alreadyLast') };
    }
    const next = [...sections];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    return { ok: true, message: t('editor.sections.movedDown'), sections: next };
  }

  if (action === 'duplicate') {
    const source = sections[index];
    if (!source) return { ok: false, message: t('editor.sections.notFound') };
    const duplicate = {
      ...source,
      id: `${source.id}-copy-${Math.random().toString(36).slice(2, 5)}`,
      enabled: true,
    };
    const next = [...sections.slice(0, index + 1), duplicate, ...sections.slice(index + 1)];
    return { ok: true, message: t('editor.sections.duplicated'), sections: next };
  }

  if (action === 'delete') {
    if (sections.length <= 1) {
      return { ok: false, message: t('editor.sections.oneRequired') };
    }
    return {
      ok: true,
      message: t('editor.sections.deleted'),
      sections: sections.filter((section) => section.id !== sectionId),
    };
  }

  if (action === 'toggle') {
    const section = sections[index];
    if (!section) return { ok: false, message: t('editor.sections.notFound') };
    const enabledCount = sections.filter((item) => item.enabled).length;
    if (section.enabled && enabledCount <= 1) {
      return { ok: false, message: t('editor.sections.oneVisible') };
    }

    const next = [...sections];
    next[index] = {
      ...section,
      enabled: !section.enabled,
    };

    return {
      ok: true,
      message: next[index].enabled ? t('editor.sections.shown') : t('editor.sections.hidden'),
      sections: next,
    };
  }

  if (action === 'add') {
    const key = payload?.sectionKey;
    // Only kinds this page has a template for can be inserted.
    if (typeof key !== 'string' || !kinds.has(key)) {
      return { ok: false, message: t('editor.sections.kindUnavailable') };
    }
    const inserted = {
      id: generateSectionId(key),
      key,
      enabled: true,
    };
    const next = [...sections.slice(0, index + 1), inserted, ...sections.slice(index + 1)];
    return {
      ok: true,
      message: t('editor.sections.inserted', { name: kinds.get(key) ?? key }),
      sections: next,
    };
  }

  if (action === 'spacing') {
    const spacingY = normalizeSpacingY(payload?.spacingY);
    const applied = applySpacing(sectionId, spacingY);
    if (!applied) return { ok: false, message: t('editor.sections.notFound') };

    const next = [...sections];
    next[index] = {
      ...next[index],
      spacing_y: spacingY,
    };
    return {
      ok: true,
      message: t('editor.sections.spacingSet', { spacing: spacingName(spacingY) }),
      sections: next,
    };
  }

  return { ok: false, message: t('editor.sections.unknownAction') };
}
