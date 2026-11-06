import { t } from '../i18n.js';

export const SPACING_Y_OPTIONS = [
  { value: 'default', label: t('editor.sections.spacingDefault') },
  { value: 'compact', label: t('editor.sections.spacingCompact') },
  { value: 'comfortable', label: t('editor.sections.spacingComfortable') },
  { value: 'spacious', label: t('editor.sections.spacingSpacious') },
  { value: 'cinematic', label: t('editor.sections.spacingCinematic') },
];

export const SPACING_Y_VALUES = SPACING_Y_OPTIONS.map((item) => item.value);
