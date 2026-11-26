/**
 * settingsAccordion.js
 * On a phone, each section of Settings folds away behind its title, and only one is open at a time (the CSS hides the rest of a
 * section unless it has .is-open). On a wide window nothing folds: every section is shown, as before.
 * openSettingsSection('orders') opens a section from elsewhere (coming back from paying, or from Stripe).
 * Whenever a section is shown it is announced with a 'binder:settings-open' event (detail: the section's name), so the ones that
 * load their own data (orders, saved cards) fetch it only when they are looked at.
 */
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const narrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
const groups = () => [...document.querySelectorAll('#view-settings .settings-group[data-section]')];
const announce = (name) => window.dispatchEvent(new CustomEvent('binder:settings-open', { detail: name }));

function setOpen(group, open) {
  group.classList.toggle('is-open', open);
  const title = group.querySelector('.settings-group-title');
  if (title) title.setAttribute('aria-expanded', String(open));
}

/** Opens one section (closing the others on a phone) and scrolls to it. */
export function openSettingsSection(name) {
  const target = groups().find((g) => g.dataset.section === name);
  if (!target) return;
  if (narrow()) groups().forEach((g) => setOpen(g, g === target));
  announce(name);
  try { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* older WebViews */ }
}

/** The sections that fetch their own data, on a wide window where they are all on screen at once: asked when the tab is shown. */
export function announceVisibleSections() {
  if (narrow()) return;   // on a phone a section announces itself when it is opened
  ['selling', 'orders', 'payment'].forEach(announce);
}

export function initSettingsAccordion() {
  for (const group of groups()) {
    const title = group.querySelector('.settings-group-title');
    if (!title) continue;
    title.insertAdjacentHTML('beforeend', CHEVRON);
    title.setAttribute('role', 'button');
    title.setAttribute('tabindex', '0');
    title.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      if (!narrow()) return;
      const open = !group.classList.contains('is-open');
      groups().forEach((g) => setOpen(g, g === group && open));
      if (open) announce(group.dataset.section);
    };
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }
}
