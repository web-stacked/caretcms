/**
 * @param {{
 *   sectionNode: HTMLElement,
 *   sectionId: string,
 *   setActiveSection: (sectionId: string) => void,
 *   isSettling: () => boolean,
 * }} options
 */
export function bindSectionActivation({ sectionNode, sectionId, setActiveSection, isSettling }) {
  // A section sliding under a resting pointer isn't the editor pointing at it.
  sectionNode.addEventListener('mouseenter', () => {
    if (!isSettling()) setActiveSection(sectionId);
  });
  sectionNode.addEventListener('focusin', () => setActiveSection(sectionId));
  sectionNode.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.cms-section-add-picker')) return;
    setActiveSection(sectionId);
  });
}
