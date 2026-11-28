// Street address suggestions while someone types a shipping address.
//   GET /api/shop/address/suggest?q=1932 market st  -> { results: [{ line1, city, region, postal, country: 'US' }] }
// Asked through the Worker (signed in only) so the person's own address is not what reaches the lookup service, and so a page
// can't be used to hammer it. The service is Photon (photon.komoot.io, built on OpenStreetMap, no key needed). Nothing is stored.
import { fail, json, sessionUser } from './lib.js';

const HOST = 'https://photon.komoot.io/api/';

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** Photon's GeoJSON answer -> up to 5 distinct US street addresses ({ line1, city, region, postal, country }). */
export function parseSuggestions(data) {
  const seen = new Set();
  const results = [];
  for (const f of (data && Array.isArray(data.features) ? data.features : [])) {
    const p = f && f.properties;
    if (!p || String(p.countrycode || '').toUpperCase() !== 'US' || !p.street) continue;
    const line1 = `${p.housenumber ? `${p.housenumber} ` : ''}${p.street}`.trim();
    const city = String(p.city || p.town || p.village || p.district || '').trim();
    const region = STATES[String(p.state || '').toLowerCase()] || '';
    const postal = String(p.postcode || '').trim();
    if (!city || !region) continue;
    const key = `${line1}|${city}|${region}|${postal}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ line1, city, region, postal, country: 'US' });
    if (results.length === 5) break;
  }
  return results;
}

export async function onAddressSuggest({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const q = (new URL(request.url).searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (q.length < 5) return json({ results: [] });
  try {
    const res = await fetch(`${HOST}?${new URLSearchParams({ q, limit: '10', lang: 'en', bbox: '-179.2,18.8,-66.9,71.5' })}`, { headers: { 'User-Agent': 'binder-address-lookup' } });
    if (!res.ok) return json({ results: [] });
    return json({ results: parseSuggestions(await res.json().catch(() => null)) });
  } catch {
    return json({ results: [] });   // the lookup being down just means no suggestions; typing still works
  }
}
