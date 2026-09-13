/**
 * @param {{ sectionNodeById: Map<string, HTMLElement>, isSelectionLocked: () => boolean }} options
 */
export function createSectionSelectionController({
  sectionNodeById,
  isSelectionLocked,
}) {
  /** @type {string | null} */
  let activeSectionId = null;
  /** @type {IntersectionObserver | null} */
  let observer = null;

  /** @param {string} sectionId */
  function setActiveSection(sectionId) {
    if (!sectionId || activeSectionId === sectionId) return;
    activeSectionId = sectionId;

    sectionNodeById.forEach((node, id) => {
      if (!(node instanceof HTMLElement)) return;
      node.classList.toggle('cms-section-active', id === sectionId);
    });
  }

  function startObserver() {
    if (typeof IntersectionObserver === 'undefined') return;
    if (observer) {
      observer.disconnect();
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (isSelectionLocked()) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0];
        if (!(top?.target instanceof HTMLElement)) return;

        const sectionId = top.target.getAttribute('data-caret-section-id');
        if (!sectionId) return;
        setActiveSection(sectionId);
      },
      {
        root: null,
        rootMargin: '-24% 0px -48% 0px',
        threshold: [0.2, 0.35, 0.5, 0.7],
      },
    );

    sectionNodeById.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      observer?.observe(node);
    });
  }

  return {
    setActiveSection,
    startObserver,
  };
}
