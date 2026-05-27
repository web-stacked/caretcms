import {
  normalizeSpacingY,
  spacingButtonLabel,
  spacingToken,
  isRecord,
} from './utils.js';
import {
  normalizeSectionsFromData,
  sectionsFromDom,
} from './model.js';
import { getPageContext } from './page-context.js';
import { fetchPageEntry, savePageLayout } from './api.js';
import {
  createSectionControlsElement,
  createSectionBadge,
  createSpacingDragHandle,
  createInsertHandle,
} from './ui-elements.js';
import { createAddPicker, createSpacingPicker } from './pickers.js';
import { mutateSections as mutateSectionsModel } from './mutations.js';
import { createSectionSelectionController } from './selection.js';
import { createSpacingDragController } from './spacing-drag.js';
import { bindDragSourceHandlers, bindDropTargetHandlers } from './reorder.js';
import { bindSectionActivation } from './activation.js';

export function mountSectionControls({
  parseCaretAttr,
  setStatus,
  showToast,
  onUnauthorized,
  onCanvasStructureChanged,
}) {
  let sectionNodes = Array.from(
    document.querySelectorAll('[data-caret-section][data-caret-section-id]'),
  );
  if (!sectionNodes.length) return;

  const pageContext = getPageContext(parseCaretAttr, sectionNodes);
  if (!pageContext) return;

  let sections = sectionsFromDom(sectionNodes);
  let entryData = {};
  let revision = 0;
  let busy = false;
  let dragSourceId = null;
  let refreshRequired = false;

  const sectionNodeById = new Map();
  const toggleButtonsById = new Map();
  const spacingButtonsById = new Map();
  const gapHandlesById = new Map();
  const sectionTemplateByKey = new Map();
  let spacingDragController = null;

  sectionNodes.forEach((sectionNode) => {
    if (!(sectionNode instanceof HTMLElement)) return;
    const sectionKey = sectionNode.getAttribute('data-caret-section') || 'home.hero';
    if (sectionTemplateByKey.has(sectionKey)) return;
    sectionTemplateByKey.set(sectionKey, sectionNode.cloneNode(true));
  });

  document
    .querySelectorAll('template[data-caret-section-template]')
    .forEach((templateNode) => {
      if (!(templateNode instanceof HTMLTemplateElement)) return;
      const sectionKey = templateNode.getAttribute('data-caret-section-template');
      if (!sectionKey || sectionTemplateByKey.has(sectionKey)) return;

      const contentNode = templateNode.content.querySelector(
        '[data-caret-section][data-caret-section-id]',
      );
      if (!(contentNode instanceof HTMLElement)) return;
      sectionTemplateByKey.set(sectionKey, contentNode.cloneNode(true));
    });

  const addPicker = createAddPicker({
    onPick: (sectionId, key) => {
      if (!canEditLayout()) return;
      const result = mutateSections('add', sectionId, { sectionKey: key });
      if (!result.ok) {
        showToast(result.message, 'error');
        return;
      }
      persistWithReload(result.message);
    },
  });

  const spacingPicker = createSpacingPicker({
    onPick: (sectionId, spacingValue) => {
      if (!canEditLayout()) return;
      const result = mutateSections('spacing', sectionId, { spacingY: spacingValue });
      if (!result.ok) {
        showToast(result.message, 'error');
        return;
      }
      persistWithReload(result.message);
    },
  });

  function serializeSectionsForLayout(sectionList) {
    return sectionList.map((section) => ({
      id: section.id,
      key: section.key,
      enabled: section.enabled,
      spacing_y: section.spacing_y,
    }));
  }

  function syncEntryDataSections() {
    if (!isRecord(entryData)) entryData = {};
    const layout = isRecord(entryData.layout) ? { ...entryData.layout } : {};
    layout.sections = serializeSectionsForLayout(sections);
    entryData.layout = layout;
  }

  syncEntryDataSections();

  function clearDropIndicators() {
    sectionNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      node.classList.remove(
        'cms-section-drop-target',
        'cms-section-drop-before',
        'cms-section-drop-after',
        'cms-section-drag-source',
      );
      delete node.dataset.dropPosition;
    });
    document.body.classList.remove('cms-section-dragging');
    document.body.classList.remove('cms-spacing-dragging');
  }

  function setControlsDisabled(disabled) {
    const shouldDisable = disabled || refreshRequired;
    document.querySelectorAll('.cms-section-btn').forEach((button) => {
      button.disabled = shouldDisable;
    });
    document.querySelectorAll('.cms-section-insert-handle').forEach((button) => {
      button.disabled = shouldDisable;
    });
    document.querySelectorAll('.cms-section-gap-handle').forEach((button) => {
      button.disabled = shouldDisable;
    });
    addPicker.setDisabled(shouldDisable);
    spacingPicker.setDisabled(shouldDisable);
  }

  function closePickers() {
    addPicker.close();
    spacingPicker.close();
  }

  function canEditLayout() {
    if (!refreshRequired) return true;
    showToast('Refresh page to continue editing section structure.', 'error');
    return false;
  }

  const selectionController = createSectionSelectionController({
    sectionNodeById,
    isSelectionLocked: () =>
      busy || refreshRequired || Boolean(dragSourceId) || Boolean(spacingDragController?.isDragging()),
  });

  function setNodeSpacingPreview(sectionId, spacingY) {
    const node = sectionNodeById.get(sectionId);
    if (!(node instanceof HTMLElement)) return;
    if (spacingY) {
      node.setAttribute('data-caret-spacing-y', spacingY);
    } else {
      node.removeAttribute('data-caret-spacing-y');
    }
  }

  function updateSpacingUi(sectionId) {
    const section = sections.find((item) => item.id === sectionId);
    if (!section) return;

    const token = spacingToken(section.spacing_y);
    const spacingBtn = spacingButtonsById.get(sectionId);
    if (spacingBtn instanceof HTMLButtonElement) {
      spacingBtn.textContent = spacingButtonLabel(section.spacing_y);
    }

    const gapHandle = gapHandlesById.get(sectionId);
    if (gapHandle instanceof HTMLButtonElement) {
      const label = gapHandle.querySelector('.cms-section-gap-label');
      if (label) {
        label.textContent = token === 'default' ? 'Y' : `Y:${token}`;
      }
    }
  }

  function updateToggleUi(sectionId) {
    const section = sections.find((item) => item.id === sectionId);
    if (!section) return;
    const toggleBtn = toggleButtonsById.get(sectionId);
    if (toggleBtn instanceof HTMLButtonElement) {
      toggleBtn.textContent = section.enabled ? 'Hide' : 'Show';
    }
  }

  function setSectionEnabledPreview(sectionId, enabled) {
    const node = sectionNodeById.get(sectionId);
    if (!(node instanceof HTMLElement)) return;
    node.classList.toggle('cms-section-disabled-preview', enabled === false);
    node.setAttribute('data-caret-section-enabled', enabled === false ? 'false' : 'true');
  }

  function getSectionSnapshot(sectionId, sectionKey) {
    return sections.find((item) => item.id === sectionId) || {
      id: sectionId,
      key: sectionKey,
      enabled: true,
    };
  }

  function updateSectionChip(sectionId, order, sectionKey) {
    const node = sectionNodeById.get(sectionId);
    if (!(node instanceof HTMLElement)) return;
    const chip = node.querySelector('.cms-section-chip');
    if (chip instanceof HTMLElement) {
      const snapshot = getSectionSnapshot(sectionId, sectionKey);
      const nextChip = createSectionBadge(snapshot, order);
      chip.textContent = nextChip.textContent;
    }
  }

  function mountSectionNode(sectionNode, sectionIndex) {
    if (!(sectionNode instanceof HTMLElement)) return;

    const sectionId = sectionNode.getAttribute('data-caret-section-id');
    if (!sectionId) return;
    const sectionKey = sectionNode.getAttribute('data-caret-section') || 'home.hero';
    const sectionSnapshot = getSectionSnapshot(sectionId, sectionKey);

    sectionNodeById.set(sectionId, sectionNode);
    sectionNode.setAttribute('data-caret-collection', pageContext.collection);
    sectionNode.setAttribute('data-caret-entry-id', pageContext.id);

    if (getComputedStyle(sectionNode).position === 'static') {
      sectionNode.style.position = 'relative';
    }

    if (sectionNode.dataset.caretSectionControlsMounted !== 'true') {
      const badge = createSectionBadge(sectionSnapshot, sectionIndex + 1);
      const controls = createSectionControlsElement();

      controls.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('.cms-section-btn');
        if (!(button instanceof HTMLButtonElement)) return;
        if (!canEditLayout()) return;
        if (busy) return;

        const currentSectionId = sectionNode.getAttribute('data-caret-section-id');
        if (!currentSectionId) return;

        selectionController.setActiveSection(currentSectionId);
        const action = button.dataset.action;
        if (!action || action === 'drag') return;

        event.preventDefault();
        event.stopPropagation();

        if (action === 'spacing') {
          closePickers();
          const currentSection = sections.find((item) => item.id === currentSectionId);
          spacingPicker.open(button, currentSectionId, currentSection?.spacing_y);
          return;
        }

        const result = mutateSections(action, currentSectionId);
        if (!result.ok) {
          showToast(result.message, 'error');
          return;
        }
        persistWithReload(result.message);
      });

      bindDragSourceHandlers({
        controls,
        sectionId,
        sectionNode,
        setDragSourceId: (value) => {
          dragSourceId = value;
        },
        clearDropIndicators,
      });

      bindSectionActivation({
        sectionNode,
        sectionId,
        setActiveSection: (id) => selectionController.setActiveSection(id),
      });

      bindDropTargetHandlers({
        sectionNode,
        sectionId,
        isBusy: () => busy || refreshRequired,
        getDragSourceId: () => dragSourceId,
        getSections: () => sections,
        setSections: (nextSections) => {
          sections = nextSections;
        },
        clearDropIndicators,
        onReordered: () => persistWithReload('Section reordered'),
      });

      sectionNode.classList.add('cms-section-editable');
      sectionNode.appendChild(badge);
      sectionNode.appendChild(controls);

      const boundaryActions = document.createElement('div');
      boundaryActions.className = 'cms-section-boundary-actions';

      const insertHandle = createInsertHandle();
      insertHandle.addEventListener('click', (event) => {
        if (!canEditLayout()) return;
        if (busy) return;
        event.preventDefault();
        event.stopPropagation();
        const currentSectionId = sectionNode.getAttribute('data-caret-section-id');
        if (!currentSectionId) return;
        selectionController.setActiveSection(currentSectionId);
        closePickers();
        addPicker.open(insertHandle, currentSectionId);
      });

      const gapHandle = createSpacingDragHandle(sectionSnapshot);
      gapHandle.addEventListener('pointerdown', (event) => {
        if (!canEditLayout()) return;
        const currentSectionId = sectionNode.getAttribute('data-caret-section-id');
        if (!currentSectionId) return;
        spacingDragController?.start(event, currentSectionId, gapHandle);
      });

      boundaryActions.appendChild(insertHandle);
      boundaryActions.appendChild(gapHandle);
      sectionNode.appendChild(boundaryActions);
      sectionNode.dataset.caretSectionControlsMounted = 'true';
    }

    const controls = sectionNode.querySelector('.cms-section-controls');
    const toggleBtn = controls?.querySelector('[data-action="toggle"]');
    if (toggleBtn instanceof HTMLButtonElement) {
      toggleButtonsById.set(sectionId, toggleBtn);
    }

    const spacingBtn = controls?.querySelector('[data-action="spacing"]');
    if (spacingBtn instanceof HTMLButtonElement) {
      spacingButtonsById.set(sectionId, spacingBtn);
    }

    const gapHandle = sectionNode.querySelector('.cms-section-gap-handle');
    if (gapHandle instanceof HTMLButtonElement) {
      gapHandlesById.set(sectionId, gapHandle);
      gapHandle.dataset.sectionId = sectionId;
    }

    updateSectionChip(sectionId, sectionIndex + 1, sectionKey);
  }

  function applySectionsToCanvas(nextSections) {
    if (!Array.isArray(nextSections) || !nextSections.length) return false;

    const parent = sectionNodes[0]?.parentNode;
    if (!parent) return false;

    const existingById = new Map();
    sectionNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const id = node.getAttribute('data-caret-section-id');
      if (!id) return;
      existingById.set(id, node);
    });

    const nextNodes = [];
    let structureChanged = false;

    for (const section of nextSections) {
      const existingNode = existingById.get(section.id);
      if (existingNode instanceof HTMLElement) {
        nextNodes.push(existingNode);
        continue;
      }

      const template = sectionTemplateByKey.get(section.key);
      if (!(template instanceof HTMLElement)) {
        return false;
      }

      const cloned = template.cloneNode(true);
      if (!(cloned instanceof HTMLElement)) {
        return false;
      }

      cloned.setAttribute('data-caret-section', section.key);
      cloned.setAttribute('data-caret-section-id', section.id);
      structureChanged = true;
      nextNodes.push(cloned);
    }

    const nextIdSet = new Set(nextSections.map((section) => section.id));
    sectionNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const id = node.getAttribute('data-caret-section-id');
      if (!id || nextIdSet.has(id)) return;
      structureChanged = true;
      sectionNodeById.delete(id);
      toggleButtonsById.delete(id);
      spacingButtonsById.delete(id);
      gapHandlesById.delete(id);
      node.remove();
    });

    nextNodes.forEach((node, index) => {
      parent.appendChild(node);
      mountSectionNode(node, index);
    });
    sectionNodes = nextNodes;

    nextSections.forEach((section) => {
      setNodeSpacingPreview(section.id, section.spacing_y);
      updateSpacingUi(section.id);
      updateToggleUi(section.id);
      setSectionEnabledPreview(section.id, section.enabled);
    });

    const firstSectionId = nextSections[0]?.id;
    if (firstSectionId) {
      selectionController.setActiveSection(firstSectionId);
    }
    selectionController.startObserver();

    if (structureChanged && typeof onCanvasStructureChanged === 'function') {
      onCanvasStructureChanged();
    }

    return true;
  }

  function markRefreshRequired({
    statusMessage,
    toastMessage,
    statusType = 'error',
    toastType = 'error',
  }) {
    refreshRequired = true;
    closePickers();
    setControlsDisabled(true);
    setStatus(statusType, statusMessage);
    showToast(toastMessage, toastType);
  }

  async function syncLatestLayoutAfterConflict() {
    const loaded = await fetchPageEntry({
      collection: pageContext.collection,
      id: pageContext.id,
      onUnauthorized,
    });
    if (!loaded) return;

    entryData = loaded.data;
    revision = loaded.revision;

    const latestSections = normalizeSectionsFromData(entryData, sectionsFromDom(sectionNodes));
    if (!applySectionsToCanvas(latestSections)) {
      sections = latestSections;
      markRefreshRequired({
        statusMessage: 'Layout changed',
        toastMessage: 'Layout changed structurally. Refresh page to see latest sections.',
      });
      return;
    }

    sections = latestSections;
    setStatus('idle', 'Layout synced');
    showToast('Layout conflict resolved with latest content.', 'success');
  }

  function applySectionSpacing(sectionId, spacingValue) {
    const index = sections.findIndex((section) => section.id === sectionId);
    if (index === -1) return false;
    const spacingY = normalizeSpacingY(spacingValue);
    sections[index] = {
      ...sections[index],
      spacing_y: spacingY,
    };
    setNodeSpacingPreview(sectionId, spacingY);
    updateSpacingUi(sectionId);
    return true;
  }

  function mutateSections(action, sectionId, payload) {
    const result = mutateSectionsModel({
      sections,
      action,
      sectionId,
      payload,
      applySpacing: (id, spacingY) => applySectionSpacing(id, spacingY),
    });
    if (result.ok && Array.isArray(result.sections)) {
      sections = result.sections;
    }
    return result;
  }

  spacingDragController = createSpacingDragController({
    isBusy: () => busy || refreshRequired,
    isReordering: () => Boolean(dragSourceId),
    closePickers,
    getSectionSpacing: (sectionId) =>
      sections.find((item) => item.id === sectionId)?.spacing_y,
    updateSpacingByToken: (sectionId, token) => applySectionSpacing(sectionId, token),
    setActiveSection: (sectionId) => selectionController.setActiveSection(sectionId),
    onCommitted: (sectionId) => {
      if (!canEditLayout()) return;
      const section = sections.find((item) => item.id === sectionId);
      showToast(`Spacing: ${section?.spacing_y ? section.spacing_y : 'default'}`, 'success');
      persistWithReload('Section spacing updated');
    },
  });

  async function persistWithReload(successMessage) {
    if (!canEditLayout()) return;
    if (busy) return;

    spacingDragController?.stop();
    busy = true;
    setControlsDisabled(true);
    closePickers();
    setStatus('saving', 'Saving layout...');

    try {
      const result = await savePageLayout({
        id: pageContext.id,
        sections,
        expectedRevision: revision,
        onUnauthorized,
      });

      if (!result.ok) {
        if (result.reason === 'conflict') {
          await syncLatestLayoutAfterConflict();
          return;
        }
        if (result.reason !== 'unauthorized') {
          const errorMessage =
            typeof result.error === 'string' && result.error.trim()
              ? result.error
              : 'Failed to save layout';
          setStatus('error', 'Layout save failed');
          showToast(errorMessage, 'error');
        }
        return;
      }

      revision = result.revision;
      syncEntryDataSections();

      if (!applySectionsToCanvas(sections)) {
        markRefreshRequired({
          statusType: 'idle',
          statusMessage: 'Layout saved (refresh required)',
          toastType: 'success',
          toastMessage: `${successMessage}. Refresh page to render structural changes.`,
        });
        return;
      }

      setStatus('idle', 'Layout saved');
      showToast(successMessage, 'success');
    } catch {
      setStatus('error', 'Layout save failed');
      showToast('Failed to save layout', 'error');
    } finally {
      busy = false;
      setControlsDisabled(false);
    }
  }

  function mountControls() {
    sectionNodes.forEach((sectionNode, sectionIndex) => {
      mountSectionNode(sectionNode, sectionIndex);
    });

    sections.forEach((section) => {
      setNodeSpacingPreview(section.id, section.spacing_y);
      updateSpacingUi(section.id);
      updateToggleUi(section.id);
      setSectionEnabledPreview(section.id, section.enabled);
    });

    const firstSectionId = sections[0]?.id;
    if (firstSectionId) selectionController.setActiveSection(firstSectionId);
    selectionController.startObserver();
  }

  mountControls();

  (async () => {
    try {
      const loaded = await fetchPageEntry({
        collection: pageContext.collection,
        id: pageContext.id,
        onUnauthorized,
      });
      if (!loaded) return;

      entryData = loaded.data;
      revision = loaded.revision;
      sections = normalizeSectionsFromData(entryData, sections);
      mountControls();
      syncEntryDataSections();
    } catch (error) {
      console.error('[cms] Failed to load section controls data', error);
      syncEntryDataSections();
    }
  })();
}
