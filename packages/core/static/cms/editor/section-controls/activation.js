/**
 * @param {{ sectionNode: HTMLElement, sectionId: string, setActiveSection: (sectionId: string) => void }} options
 */
export function bindSectionActivation({ sectionNode, sectionId, setActiveSection }) {
  sectionNode.addEventListener('mouseenter', () => setActiveSection(sectionId));
  sectionNode.addEventListener('focusin', () => setActiveSection(sectionId));
  sectionNode.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.cms-section-add-picker')) return;
    setActiveSection(sectionId);
  });
}
