// Shipping: what a parcel of cards costs to send, buying the label, and following it to the door. Cards have no weight or size in
// Binder, so the parcel is guessed from how many cards one seller is sending (see TIERS). When SHIPPO_API_KEY is set Shippo
// quotes a real rate from the seller's address to the buyer's (the cheapest USPS one) and the buyer is charged that plus
// SHIPPING_MARKUP_PERCENT (default 20%) in case the real label costs more; the seller then buys the label through Binder, which
// gets a tracking number, and Shippo tells us when it is delivered. With no key (or if Shippo is down) a flat rate per tier is
// charged and the seller types the tracking number by hand.
import { markUp, shippingMarkupPercent } from './money.js';

export const TIERS = [
  { max: 20, name: 'Envelope', flatCents: 500, parcel: { length: '9', width: '6', height: '1', distance_unit: 'in', weight: '4', mass_unit: 'oz' } },
  { max: 100, name: 'Small box', flatCents: 800, parcel: { length: '8', width: '6', height: '4', distance_unit: 'in', weight: '12', mass_unit: 'oz' } },
  { max: 500, name: 'Box', flatCents: 1500, parcel: { length: '12', width: '9', height: '6', distance_unit: 'in', weight: '3', mass_unit: 'lb' } },
  { max: Infinity, name: 'Large box', flatCents: 2500, parcel: { length: '14', width: '12', height: '8', distance_unit: 'in', weight: '7', mass_unit: 'lb' } },
];
export const tierFor = (cardCount) => TIERS.find((t) => cardCount <= t.max);

const SHIPPO = 'https://api.goshippo.com';
const TIMEOUT_MS = 9000;

export const shippoConfigured = (env) => !!(env && typeof env.SHIPPO_API_KEY === 'string' && env.SHIPPO_API_KEY.trim());

async function shippoCall(env, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SHIPPO}${path}`, {
      method,
      headers: { Authorization: `ShippoToken ${env.SHIPPO_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data.detail || data.message)) || `Shippo answered ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const fromSeller = (s) => ({ name: s.legal_name, street1: s.addr_line1, street2: s.addr_line2 || undefined, city: s.city, state: s.region, zip: s.postal, country: s.country, phone: s.phone });
const toBuyer = (a) => ({ name: a.name, street1: a.line1, street2: a.line2 || undefined, city: a.city, state: a.region, zip: a.postal, country: a.country, phone: a.phone || undefined });

const cents = (amount) => Math.round(Number(amount) * 100);

/** The cheapest usable USPS rate of a Shippo shipment (any carrier if no USPS rate came back), or null. */
export function cheapestRate(rates) {
  const usable = (Array.isArray(rates) ? rates : []).filter((r) => r && Number(r.amount) > 0 && (!r.currency || r.currency === 'USD'));
  const pool = usable.filter((r) => String(r.provider).toUpperCase() === 'USPS');
  return (pool.length ? pool : usable).sort((a, b) => Number(a.amount) - Number(b.amount))[0] || null;
}

async function shipment(env, seller, to, tier) {
  return shippoCall(env, 'POST', '/shipments/', { address_from: fromSeller(seller), address_to: toBuyer(to), parcels: [tier.parcel], async: false });
}

/**
 * What the buyer pays to have one seller's cards sent: { cents, mode: 'shippo' | 'flat', service, days }. Never throws: any
 * trouble with Shippo falls back to the flat rate for the tier.
 */
export async function quoteShipping(env, { seller, to, cardCount }) {
  const tier = tierFor(cardCount);
  const flat = { cents: tier.flatCents, mode: 'flat', service: `${tier.name}, flat rate`, days: 0 };
  if (!shippoConfigured(env) || seller.country !== 'US' || to.country !== 'US') return flat;
  try {
    const made = await shipment(env, seller, to, tier);
    const rate = cheapestRate(made.rates);
    if (!rate) return flat;
    const name = (rate.servicelevel && rate.servicelevel.name) || '';
    return { cents: markUp(cents(rate.amount), shippingMarkupPercent(env)), mode: 'shippo', service: `${rate.provider} ${name}`.trim(), days: Number(rate.estimated_days) || 0 };
  } catch {
    return flat;
  }
}

/** Buys the label: { trackingNumber, trackingUrl, labelUrl, carrier, labelCostCents, service }. Throws a readable Error. */
export async function buyLabel(env, { seller, to, cardCount, metadata }) {
  if (!shippoConfigured(env)) throw new Error('Labels are not switched on: enter a tracking number instead');
  const tier = tierFor(cardCount);
  try {
    const made = await shipment(env, seller, to, tier);
    const rate = cheapestRate(made.rates);
    if (!rate) throw new Error('No shipping rate was available for this address');
    const bought = await shippoCall(env, 'POST', '/transactions', { rate: rate.object_id, label_file_type: 'PDF', async: false, metadata: String(metadata || '').slice(0, 100) });
    if (bought.status !== 'SUCCESS' || !bought.tracking_number) {
      const reason = Array.isArray(bought.messages) && bought.messages[0] && (bought.messages[0].text || bought.messages[0]);
      throw new Error(typeof reason === 'string' && reason ? reason : 'The label could not be bought');
    }
    return {
      trackingNumber: bought.tracking_number,
      trackingUrl: bought.tracking_url_provider || '',
      labelUrl: bought.label_url || '',
      carrier: String(rate.provider || '').toLowerCase(),
      labelCostCents: cents(rate.amount),
      service: `${rate.provider} ${(rate.servicelevel && rate.servicelevel.name) || ''}`.trim(),
    };
  } catch (err) {
    throw new Error(err && err.message ? err.message : "Couldn't reach the label service, try again in a moment");
  }
}

/** The carrier's latest status for a parcel: PRE_TRANSIT, TRANSIT, DELIVERED, RETURNED, FAILURE or UNKNOWN; null when unknown. */
export async function trackingStatus(env, carrier, trackingNumber) {
  if (!shippoConfigured(env)) return null;
  try {
    const data = await shippoCall(env, 'GET', `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`);
    return (data && data.tracking_status && data.tracking_status.status) || null;
  } catch {
    return null;
  }
}

const CARRIER_TOKENS = { usps: 'usps', ups: 'ups', fedex: 'fedex', dhl: 'dhl_express' };
const carrierKey = (carrier) => String(carrier || '').toLowerCase().replace(/[^a-z]/g, '');

/** A tracking page for a parcel, for the carriers people use most (empty when the carrier is not one of them). */
export function trackingLink(carrier, number) {
  const n = encodeURIComponent(number);
  const key = carrierKey(carrier);
  if (key.startsWith('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (key.startsWith('ups')) return `https://www.ups.com/track?tracknum=${n}`;
  if (key.startsWith('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (key.startsWith('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`;
  return '';
}

/**
 * Asks Shippo to follow a tracking number that was typed by hand (so it can tell us when it is delivered). Best effort: false
 * when Shippo is off or the carrier is not one it follows.
 */
export async function registerTracking(env, carrier, trackingNumber, metadata) {
  const token = CARRIER_TOKENS[carrierKey(carrier)];
  if (!shippoConfigured(env) || !token) return false;
  try {
    await shippoCall(env, 'POST', '/tracks/', { carrier: token, tracking_number: trackingNumber, metadata: String(metadata || '').slice(0, 100) });
    return true;
  } catch {
    return false;
  }
}
export const shippoCarrierToken = (carrier) => CARRIER_TOKENS[carrierKey(carrier)] || '';
