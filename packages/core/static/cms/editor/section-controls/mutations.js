import { HOME_SECTION_KEYS } from './constants.js';
import {
  generateSectionId,
  humanizeSectionKey,
  normalizeSpacingY,
} from './utils.js';

export function mutateSections({
  sections,
  action,
  sectionId,
  payload,
  applySpacing,
}) {
  const index = sections.findIndex((section) => section.id === sectionId);
  if (index === -1) return { ok: false, message: 'Section not found' };

  if (action === 'up') {
    if (index === 0) return { ok: false, message: 'Section is already first' };
    const next = [...sections];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    return { ok: true, message: 'Section moved up', sections: next };
  }

  if (action === 'down') {
    if (index === sections.length - 1) {
      return { ok: false, message: 'Section is already last' };
    }
    const next = [...sections];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    return { ok: true, message: 'Section moved down', sections: next };
  }

  if (action === 'duplicate') {
    const source = sections[index];
    const duplicate = {
      ...source,
      id: `${source.id}-copy-${Math.random().toString(36).slice(2, 5)}`,
      enabled: true,
    };
    const next = [...sections.slice(0, index + 1), duplicate, ...sections.slice(index + 1)];
    return { ok: true, message: 'Section duplicated', sections: next };
  }

  if (action === 'delete') {
    if (sections.length <= 1) {
      return { ok: false, message: 'At least one section is required' };
    }
    return {
      ok: true,
      message: 'Section deleted',
      sections: sections.filter((section) => section.id !== sectionId),
    };
  }

  if (action === 'toggle') {
    const section = sections[index];
    const enabledCount = sections.filter((item) => item.enabled).length;
    if (section.enabled && enabledCount <= 1) {
      return { ok: false, message: 'At least one section must remain visible' };
    }

    const next = [...sections];
    next[index] = {
      ...section,
      enabled: !section.enabled,
    };

    return {
      ok: true,
      message: next[index].enabled ? 'Section shown' : 'Section hidden',
      sections: next,
    };
  }

  if (action === 'add') {
    const key = payload?.sectionKey;
    if (typeof key !== 'string' || !HOME_SECTION_KEYS.includes(key)) {
      return { ok: false, message: 'Invalid section key' };
    }
    const inserted = {
      id: generateSectionId(key),
      key,
      enabled: true,
    };
    const next = [...sections.slice(0, index + 1), inserted, ...sections.slice(index + 1)];
    return {
      ok: true,
      message: `Inserted ${humanizeSectionKey(key)}`,
      sections: next,
    };
  }

  if (action === 'spacing') {
    const spacingY = normalizeSpacingY(payload?.spacingY);
    const applied = applySpacing(sectionId, spacingY);
    if (!applied) return { ok: false, message: 'Section not found' };

    const next = [...sections];
    next[index] = {
      ...next[index],
      spacing_y: spacingY,
    };
    return {
      ok: true,
      message: `Spacing set to ${spacingY ? spacingY : 'default'}`,
      sections: next,
    };
  }

  return { ok: false, message: 'Unknown action' };
}
