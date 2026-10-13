// What a person must give to register as a seller, checked the same way in the Worker (here) and in the app
// (app/js/sellerProfile.js: keep the two in step; both are tested against the same cases). Returns { error } (a message
// the person can act on) or { seller }, the cleaned fields. Nothing here ever sees a card number: those are typed into the
// payment processors' own fields.

// The countries Stripe Connect can pay out to (a seller picks one of these as the country of their address).
export const SELLER_COUNTRIES = [
  'AE', 'AT', 'AU', 'BE', 'BG', 'BR', 'CA', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'IE',
  'IT', 'JP', 'LT', 'LU', 'LV', 'MT', 'MX', 'NL', 'NO', 'NZ', 'PL', 'PT', 'RO', 'SE', 'SG', 'SI', 'SK', 'TH', 'US',
];
export const PAYOUT_KINDS = ['stripe', 'venmo', 'paypal'];

const NAME_RE = /^[\p{L}][\p{L}\p{M}'’.\- ]*$/u;
const POSTAL_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{1,10}[A-Za-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const squash = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** "(555) 123-4567" -> "5551234567", "+44 20 7946 0958" -> "+442079460958"; null when it isn't a phone number. */
export function cleanPhone(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\+?[\d\s().\-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (text.startsWith('+') ? '+' : '') + digits;
}

export function cleanSeller(body) {
  if (!body || typeof body !== 'object') return { error: 'Fill in the form' };
  const legalName = squash(body.legalName);
  if (legalName.length < 3 || legalName.length > 100 || !NAME_RE.test(legalName) || !/\S+ \S+/.test(legalName)) {
    return { error: 'Enter your full legal name: first and last name, as on your ID' };
  }
  const phone = cleanPhone(body.phone);
  if (!phone) return { error: 'Enter a phone number we can reach you on (digits, and + for a country code)' };

  const a = body.address && typeof body.address === 'object' ? body.address : {};
  const line1 = squash(a.line1);
  const line2 = squash(a.line2);
  const city = squash(a.city);
  const region = squash(a.region);
  const postal = squash(a.postal);
  const country = typeof a.country === 'string' ? a.country.trim().toUpperCase() : '';
  if (line1.length < 3 || line1.length > 100) return { error: 'Enter your street address' };
  if (line2.length > 100) return { error: 'The second address line is too long' };
  if (city.length < 2 || city.length > 60) return { error: 'Enter your city' };
  if (region.length < 2 || region.length > 60) return { error: 'Enter your state, province or region' };
  if (!POSTAL_RE.test(postal)) return { error: 'Enter your postal or ZIP code' };
  if (!SELLER_COUNTRIES.includes(country)) return { error: 'Pick the country of your address from the list' };

  const payout = body.payout && typeof body.payout === 'object' ? body.payout : { kind: 'stripe' };
  const kind = payout.kind === undefined ? 'stripe' : payout.kind;
  if (!PAYOUT_KINDS.includes(kind)) return { error: 'Pick how you want to be paid: bank or debit card, Venmo or PayPal' };
  let ref = '';
  if (kind === 'venmo') {
    if (country !== 'US') return { error: 'Venmo is only available to sellers in the United States' };
    const venmoPhone = cleanPhone(typeof payout.ref === 'string' && payout.ref.trim() ? payout.ref : phone);
    if (!venmoPhone) return { error: 'Enter the phone number your Venmo account uses' };
    ref = venmoPhone;
  } else if (kind === 'paypal') {
    ref = typeof payout.ref === 'string' ? payout.ref.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(ref) || ref.length > 254) return { error: 'Enter the email address of your PayPal account' };
  }
  return { seller: { legalName, phone, address: { line1, line2, city, region, postal, country }, payout: { kind, ref } } };
}
