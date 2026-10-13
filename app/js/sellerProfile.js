/**
 * sellerProfile.js
 * What a person must give to register as a seller, checked in the page before it is sent. These are the same rules and messages
 * as the Worker's (cloudflare/src/sellerInput.js, which checks it again: keep the two in step; a test runs both on the same
 * cases). Nothing here ever sees a card number: those are typed into the payment processors' own pages.
 */
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

/** "United States" for "US" (the code when no name is known). `names` is an Intl.DisplayNames for regions, or null. */
export function countryName(code, names) {
  try {
    return (names && names.of(code)) || code;
  } catch (e) {
    return code;
  }
}

/** The words for how a seller is paid: "Bank account or debit card (Stripe)", "Venmo (555…)", "PayPal (a@b.co)". */
export function payoutText(payout) {
  if (!payout || payout.kind === 'stripe') return 'Bank account or debit card, through Stripe';
  if (payout.kind === 'venmo') return `Venmo (${payout.ref})`;
  return `PayPal (${payout.ref})`;
}

/**
 * Where a registered seller stands, as { ready, headline, detail, needsStripe }: ready when they can sell (paid through Stripe once
 * Stripe has enabled payouts, or through Venmo or PayPal), else what is left.
 */
export function sellerStatus(seller, payments) {
  if (!seller) return { ready: false, headline: 'Not a seller yet', detail: '', needsStripe: false };
  if (seller.payout.kind !== 'stripe') return { ready: true, headline: 'Ready to sell', detail: `You will be paid with ${payoutText(seller.payout)}.`, needsStripe: false };
  if (seller.ready) return { ready: true, headline: 'Ready to sell', detail: 'Stripe will pay you to your bank account or debit card.', needsStripe: false };
  if (!payments || !payments.stripe) {
    return { ready: false, headline: 'Profile saved', detail: "Payments aren't switched on yet, so payout setup with Stripe can't start. Your profile is kept.", needsStripe: false };
  }
  const stripe = seller.stripe || {};
  if (stripe.unknown) return { ready: false, headline: 'Profile saved', detail: "Couldn't check Stripe just now. Try again in a moment.", needsStripe: true };
  return {
    ready: false,
    headline: stripe.account ? 'Finish setting up payouts' : 'One more step: set up payouts',
    detail: "Stripe's own page collects your ID and the bank account or debit card to pay you into. Binder never sees those.",
    needsStripe: true,
  };
}
