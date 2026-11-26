/**
 * addressForm.js
 * The shipping address fields, used by checkout and by the saved address in Settings. The values are checked with cleanShipTo()
 * (shopInput.js, the same rules as the account service).
 */
import { escapeHtml } from './dom.js';

/** The fields, filled in from `a` (a saved address) when there is one. */
export function addressFormHtml(a) {
  const v = (key) => escapeHtml((a && a[key]) || '');
  return `
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
      <input class="field-input" data-f="postal" type="text" autocomplete="postal-code" placeholder="ZIP code" maxlength="12" value="${v('postal')}">
      <input class="field-input" data-f="phone" type="tel" autocomplete="tel" placeholder="Phone (optional)" maxlength="30" value="${v('phone')}">
    </div>
    <p class="field-hint">We ship within the United States for now.</p>`;
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
