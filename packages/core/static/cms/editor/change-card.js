const MARGIN = 8;

/**
 * The card that explains one change on the page: a coloured title, label/value
 * rows and buttons. The Changes view and the "since you were last here" tour
 * both use it, so a change always looks the same wherever it is shown.
 *
 * @param {{
 *   label: string,
 *   title: string,
 *   tone: 'mine' | 'site' | 'both',
 *   rows: Array<[string, string]>,
 *   actions: Array<{ label: string, primary?: boolean, run: () => void }>,
 *   note?: string,
 * }} options
 */
export function buildChangeCard({ label, title, tone, rows, actions, note }) {
  const card = document.createElement('div');
  card.className = 'cms-change-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', label);
  card.setAttribute('data-caret-ui', '');
  const heading = document.createElement('p');
  heading.className = `cms-change-title cms-change-${tone}`;
  heading.textContent = title;
  card.append(heading);
  for (const [name, value] of rows) {
    const line = document.createElement('div');
    line.className = 'cms-change-row';
    const key = document.createElement('span');
    key.textContent = name;
    const text = document.createElement('strong');
    text.textContent = value;
    line.append(key, text);
    card.append(line);
  }
  if (note) {
    const extra = document.createElement('p');
    extra.className = 'cms-change-note';
    extra.textContent = note;
    card.append(extra);
  }
  const group = document.createElement('div');
  group.className = 'cms-change-actions';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    if (action.primary) button.className = 'cms-change-primary';
    button.addEventListener('click', action.run);
    group.append(button);
  }
  card.append(group);
  return card;
}

/**
 * Place a card (already in the document, absolutely positioned) next to the
 * element it is about: below it, or above it when below would reach the
 * editor's toolbar or the bottom of the window. Horizontally from `leftAt`
 * (a viewport x), kept inside the window.
 *
 * @param {HTMLElement} card @param {Element} element @param {number} leftAt
 */
export function placeChangeCard(card, element, leftAt) {
  const box = element.getBoundingClientRect();
  const width = card.offsetWidth;
  const left = Math.max(MARGIN, Math.min(leftAt, document.documentElement.clientWidth - width - MARGIN));
  const toolbarTop = document.querySelector('.cms-toolbar-inner')?.getBoundingClientRect().top ?? window.innerHeight;
  const room = Math.min(window.innerHeight, toolbarTop) - MARGIN;
  const below = box.bottom + MARGIN;
  const above = box.top - MARGIN - card.offsetHeight;
  const top = below + card.offsetHeight > room && above >= 0 ? above : below;
  card.style.left = `${left + window.scrollX}px`;
  card.style.top = `${top + window.scrollY}px`;
}
