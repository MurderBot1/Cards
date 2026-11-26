// What the shop accepts from people, checked the same way in the app (here) and in the Worker (cloudflare/src/shopInput.js: keep
// the two in step; both are tested against the same cases). Each returns { error } (a message the person can act on) or the
// cleaned value. Nothing here ever sees a card number: those are typed into Stripe's own page.
import { cleanPhone } from './sellerProfile.js';

export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const MAX_PRICE_CENTS = 1000000;   // $10,000 a card
export const MAX_QUANTITY = 999;
export const MAX_ACTIVE_LISTINGS = 500;
export const MAX_CART_LINES = 100;
export const SHIP_TO_COUNTRIES = ['US'];  // shipping labels and rates are US-domestic for now

const squash = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const NAME_RE = /^[\p{L}][\p{L}\p{M}'’.\- ]*$/u;
const POSTAL_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{1,10}[A-Za-z0-9]$/;

/** A listing the seller wants to sell: one card in one condition at one price. */
export function cleanListing(body) {
  if (!body || typeof body !== 'object') return { error: 'Fill in the listing' };
  const name = squash(body.name);
  if (name.length < 1 || name.length > 120) return { error: 'Enter the card name' };
  const game = typeof body.game === 'string' ? body.game.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{1,20}$/.test(game)) return { error: 'Pick the game this card is from' };
  const set = squash(body.set).slice(0, 16);
  const number = squash(body.number).slice(0, 16);
  const language = squash(body.language) || 'English';
  if (language.length > 20) return { error: 'The language is too long' };
  const cardId = squash(body.cardId);
  if (cardId.length < 1 || cardId.length > 80 || !/^[A-Za-z0-9_.:\-]+$/.test(cardId)) return { error: 'Pick the card from the search results' };
  const condition = body.condition === undefined ? 'Near Mint' : body.condition;
  if (!CONDITIONS.includes(condition)) return { error: 'Pick the condition of the card' };
  const priceCents = body.priceCents;
  if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > MAX_PRICE_CENTS) return { error: 'Enter a price between $0.01 and $10,000.00' };
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) return { error: `Enter how many you have, 0 to ${MAX_QUANTITY}` };
  const note = squash(body.note);
  if (note.length > 200) return { error: 'Keep the note under 200 characters' };
  let image = typeof body.image === 'string' ? body.image.trim() : '';
  if (image && (image.length > 300 || !/^https:\/\/[^\s]+$/.test(image))) image = '';  // only https pictures are ever shown
  return { listing: { game, cardId, name, set, number, image, condition, foil: body.foil === true, language, priceCents, quantity, note } };
}

/** "$12.50" / "12.5" / "12" -> 1250 (cents), or null. For the price box in the listing form. */
export function parsePriceToCents(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return null;
  const t = String(text).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents >= 1 && cents <= MAX_PRICE_CENTS ? cents : null;
}

/** Where a buyer wants their order sent. */
export function cleanShipTo(body) {
  if (!body || typeof body !== 'object') return { error: 'Enter your shipping address' };
  const name = squash(body.name);
  if (name.length < 2 || name.length > 100 || !NAME_RE.test(name)) return { error: 'Enter the name to put on the parcel' };
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const phone = rawPhone ? cleanPhone(rawPhone) : '';
  if (rawPhone && !phone) return { error: 'That phone number does not look right (or leave it empty)' };
  const line1 = squash(body.line1);
  const line2 = squash(body.line2);
  const city = squash(body.city);
  const region = squash(body.region);
  const postal = squash(body.postal);
  const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : 'US';
  if (line1.length < 3 || line1.length > 100) return { error: 'Enter your street address' };
  if (line2.length > 100) return { error: 'The second address line is too long' };
  if (city.length < 2 || city.length > 60) return { error: 'Enter your city' };
  if (region.length < 2 || region.length > 60) return { error: 'Enter your state' };
  if (!POSTAL_RE.test(postal)) return { error: 'Enter your ZIP code' };
  if (!SHIP_TO_COUNTRIES.includes(country)) return { error: 'We only ship within the United States for now' };
  return { address: { name, phone: phone || '', line1, line2, city, region, postal, country } };
}

/** A tracking number typed by hand. */
export function cleanTracking(body) {
  if (!body || typeof body !== 'object') return { error: 'Enter the carrier and tracking number' };
  const carrier = squash(body.carrier).slice(0, 40);
  const trackingNumber = typeof body.trackingNumber === 'string' ? body.trackingNumber.replace(/\s+/g, '').toUpperCase() : '';
  if (carrier.length < 2) return { error: 'Enter the carrier (USPS, UPS, FedEx…)' };
  if (!/^[A-Z0-9\-]{6,40}$/.test(trackingNumber)) return { error: 'Enter the tracking number (letters and digits)' };
  return { tracking: { carrier, trackingNumber } };
}
