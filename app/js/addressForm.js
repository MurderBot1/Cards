/**
 * addressForm.js
 * The shipping address fields, used by checkout and by the saved address in Settings. The values are checked with cleanShipTo()
 * (shopInput.js, the same rules as the account service).
 */
import { escapeHtml } from './dom.js';

/** "5551234567" -> "(555) 123-4567"; anything else (a +country code, a partial number) is only tidied. */
export function formatPhone(raw) {
  const text = String(raw || '');
  if (text.trim().startsWith('+')) return `+${text.replace(/\D/g, '').slice(0, 15)}`;
  const d = text.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** "787011234" -> "78701-1234": digits only, a dash after the fifth. */
export function formatZip(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 9);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

/** The fields, filled in from `a` (a saved address) when there is one. */
export function addressFormHtml(a) {
  const v = (key) => escapeHtml((a && a[key]) || '');
  return `<div class="address-form">
    <label class="field-label">Name on the parcel</label>
    <input class="field-input" data-f="name" type="text" name="ship-name" autocomplete="shipping name" maxlength="100" value="${v('name')}">
    <label class="field-label">Address</label>
    <input class="field-input" data-f="line1" type="text" name="ship-line1" autocomplete="shipping address-line1" placeholder="Street address" maxlength="100" value="${v('line1')}">
    <input class="field-input" data-f="line2" type="text" name="ship-line2" autocomplete="shipping address-line2" placeholder="Apartment, suite (optional)" maxlength="100" value="${v('line2')}">
    <div class="seller-row">
      <input class="field-input" data-f="city" type="text" name="ship-city" autocomplete="shipping address-level2" placeholder="City" maxlength="60" value="${v('city')}">
      <input class="field-input" data-f="region" type="text" name="ship-region" autocomplete="shipping address-level1" placeholder="State" maxlength="60" value="${v('region')}">
    </div>
    <div class="seller-row">
      <input class="field-input" data-f="postal" type="text" name="ship-postal" autocomplete="shipping postal-code" placeholder="ZIP code" maxlength="10" inputmode="numeric" value="${escapeHtml(formatZip(a && a.postal))}">
      <input class="field-input" data-f="phone" type="tel" name="ship-phone" autocomplete="shipping tel" placeholder="Phone (optional)" maxlength="30" value="${escapeHtml(formatPhone(a && a.phone))}" inputmode="tel">
    </div>
    <p class="field-hint">We ship within the United States for now.</p></div>`;
}

/**
 * Addresses worth offering while someone types: the one saved for next time and the seller profile's (their name, address and
 * phone), without repeats. Each is { name, phone, line1, line2, city, region, postal, country }.
 */
export function addressSuggestions(saved, seller) {
  const out = [];
  const seen = new Set();
  const add = (a) => {
    if (!a || !a.line1 || !a.city) return;
    const key = [a.name, a.line1, a.line2, a.city, a.postal].join('|').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: a.name || '', phone: a.phone || '', line1: a.line1, line2: a.line2 || '', city: a.city, region: a.region || '', postal: a.postal || '', country: 'US' });
  };
  add(saved);
  if (seller && seller.address && seller.address.country === 'US') add({ ...seller.address, name: seller.legalName, phone: seller.phone });
  return out;
}

/** The suggestions whose `field` ("name" or "line1") starts with what has been typed so far (and is not already all of it). */
export function matchSuggestions(suggestions, field, typed) {
  const t = String(typed || '').trim().toLowerCase();
  if (!t) return [];
  return (suggestions || []).filter((a) => {
    const value = String(a[field] || '').toLowerCase();
    return value.startsWith(t) && value !== t;
  });
}

/**
 * Tidies the phone and ZIP as they are typed, and offers a saved address under the name and street fields once what is typed
 * matches the start of one (a tap fills every field). Call once after the fields are on the page.
 */
export function wireAddressForm(root, suggestions = [], lookup = null) {
  const tidy = (key, format) => {
    const el = root.querySelector(`[data-f="${key}"]`);
    if (el) el.addEventListener('input', () => { const next = format(el.value); if (next !== el.value) el.value = next; });
  };
  tidy('phone', formatPhone);
  tidy('postal', formatZip);
  const form = root.querySelector('.address-form');
  if (!form || (!suggestions.length && !lookup)) return;
  const box = document.createElement('div');
  box.className = 'address-suggest hidden';
  form.insertBefore(box, root.querySelector('[data-f="line2"]'));
  const field = (key) => root.querySelector(`[data-f="${key}"]`);
  // a saved address fills every field; a street found by the lookup fills only the street, city, state and ZIP
  const fill = (a) => {
    for (const key of ['name', 'phone', 'line1', 'line2', 'city', 'region', 'postal']) {
      if (!(key in a)) continue;
      const el = field(key);
      if (el) el.value = key === 'phone' ? formatPhone(a[key]) : key === 'postal' ? formatZip(a[key]) : a[key] || '';
    }
    box.classList.add('hidden');
  };
  let shown = [];
  const draw = (found) => {
    shown = found;
    box.replaceChildren(...found.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'address-suggest-item';
      b.textContent = addressLine(a);
      b.addEventListener('click', () => fill(a));
      return b;
    }));
    box.classList.toggle('hidden', !found.length);
  };
  let timer = 0;
  let asked = 0;
  const onType = (key) => {
    const saved = matchSuggestions(suggestions, key, field(key) && field(key).value);
    draw(saved);
    clearTimeout(timer);
    const typed = key === 'line1' && field('line1') ? field('line1').value.trim() : '';
    if (!lookup || typed.length < 5) return;
    const ticket = ++asked;
    timer = setTimeout(async () => {
      let found = [];
      try { found = await lookup(typed); } catch (e) { /* no lookup, no suggestions: typing still works */ }
      if (ticket !== asked || !Array.isArray(found)) return;   // the person kept typing: this answer is stale
      draw([...saved, ...found].slice(0, 6));
    }, 350);
  };
  for (const key of ['name', 'line1']) {
    const el = field(key);
    if (el) el.addEventListener('input', () => onType(key));
  }
  return { suggestionsShown: () => shown };
}

/** The values typed into the fields inside `root`. */
export function readAddressForm(root) {
  const get = (key) => {
    const el = root.querySelector(`[data-f="${key}"]`);
    return el ? el.value : '';
  };
  return { name: get('name'), phone: get('phone'), line1: get('line1'), line2: get('line2'), city: get('city'), region: get('region'), postal: get('postal'), country: 'US' };
}

/** One line for a saved address: "Julie Buyer, 9 Buyer Lane, Austin TX 78701". */
export function addressLine(a) {
  if (!a) return '';
  return [a.name, a.line1, a.line2, `${a.city} ${a.region} ${a.postal}`.trim()].filter(Boolean).join(', ');
}
