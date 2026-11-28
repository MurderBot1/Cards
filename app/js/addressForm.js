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
    <input class="field-input" data-f="name" type="text" autocomplete="name" maxlength="100" value="${v('name')}">
    <label class="field-label">Address</label>
    <input class="field-input" data-f="line1" type="text" autocomplete="address-line1" placeholder="Street address" maxlength="100" value="${v('line1')}">
    <input class="field-input" data-f="line2" type="text" autocomplete="address-line2" placeholder="Apartment, suite (optional)" maxlength="100" value="${v('line2')}">
    <div class="seller-row">
      <input class="field-input" data-f="city" type="text" autocomplete="address-level2" placeholder="City" maxlength="60" value="${v('city')}">
      <input class="field-input" data-f="region" type="text" autocomplete="address-level1" placeholder="State" maxlength="60" value="${v('region')}">
    </div>
    <div class="seller-row">
      <input class="field-input" data-f="postal" type="text" autocomplete="postal-code" placeholder="ZIP code" maxlength="10" inputmode="numeric" value="${escapeHtml(formatZip(a && a.postal))}">
      <input class="field-input" data-f="phone" type="tel" autocomplete="tel" placeholder="Phone (optional)" maxlength="30" value="${escapeHtml(formatPhone(a && a.phone))}" inputmode="tel">
    </div>
    <p class="field-hint">We ship within the United States for now.</p></div>`;
}

/** Tidies the phone and ZIP as they are typed (call once after the fields are on the page). */
export function wireAddressForm(root) {
  const tidy = (key, format) => {
    const el = root.querySelector(`[data-f="${key}"]`);
    if (el) el.addEventListener('input', () => { const next = format(el.value); if (next !== el.value) el.value = next; });
  };
  tidy('phone', formatPhone);
  tidy('postal', formatZip);
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
