/**
 * currencyPicker.js
 * What the currency picker in Settings shows, as plain data (the page just draws it): the card for the currency in use
 * and the rows of the list to choose from, each with its symbol, name and what US$10 comes to. Nothing here touches the
 * page; `service` is the currency service of currency.js.
 */

/** "£" for GBP, "$" for USD, "CHF" where a currency has no short symbol; the code if it can't be worked out. */
export function symbolOf(code, locale) {
  try {
    const part = new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(1)
      .find((p) => p.type === 'currency');
    return part ? part.value : code;
  } catch (e) {
    return code;
  }
}

/** "British pound" for GBP (the code when no name is known). `names` is an Intl.DisplayNames or null. */
export function nameOf(code, names) {
  try {
    return (names && names.of(code)) || code;
  } catch (e) {
    return code;
  }
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; '' when there is no time. */
export function ageText(at, now) {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// what US$10 comes to in a currency ("$10.00 = £7.90"), '' when there is no rate or it is dollars
function sampleFor(service, code) {
  if (code === 'USD') return '';
  const there = service.formatIn(code, 10);
  return there === null ? '' : `${service.formatIn('USD', 10)} = ${there}`;
}

/**
 * The card for the currency in use: { symbol, title, subtitle, rates }.
 *   title: "British pound (GBP)"; subtitle: how it was picked; rates: "$10.00 = £7.90 · rates from 3 hours ago".
 */
export function summary(service, { names, locale, now }) {
  const shown = service.code();
  const wanted = service.wanted();
  const auto = service.choice() === 'auto';
  let subtitle = auto ? "Automatic: a guess from your device's region" : 'Your choice';
  if (shown !== wanted) subtitle = 'Rates not loaded yet, so prices show in US dollars';
  const bits = [sampleFor(service, shown) || (shown === 'USD' ? 'Prices are already in US dollars' : '')];
  const age = ageText(service.updatedAt(), now);
  if (age) bits.push(`rates from ${age}`);
  return {
    symbol: symbolOf(shown, locale),
    title: `${nameOf(shown, names)} (${shown})`,
    subtitle,
    rates: bits.filter(Boolean).join(' · '),
  };
}

/**
 * The rows of the list, filtered by what was typed (a name or code), "Automatic" first, the rest by name:
 *   { value, symbol, title, detail, sample, selected }  (value: 'auto' or the code)
 */
export function currencyRows(service, query, { names, locale }) {
  const q = String(query || '').trim().toLowerCase();
  const choice = service.choice();
  const wanted = service.wanted();
  const rows = [{
    value: 'auto',
    symbol: symbolOf(wanted, locale),
    title: 'Automatic',
    detail: `${nameOf(wanted, names)} (${wanted}), from your device's region`,
    sample: sampleFor(service, wanted),
    selected: choice === 'auto',
    search: `automatic ${wanted} ${nameOf(wanted, names)}`.toLowerCase(),
  }];
  const codes = service.available().slice().sort((a, b) => nameOf(a, names).localeCompare(nameOf(b, names)));
  for (const code of codes) {
    rows.push({
      value: code,
      symbol: symbolOf(code, locale),
      title: nameOf(code, names),
      detail: code,
      sample: sampleFor(service, code),
      selected: choice === code,
      search: `${code} ${nameOf(code, names)}`.toLowerCase(),
    });
  }
  return rows.filter((r) => !q || r.search.includes(q)).map(({ search, ...row }) => row);
}
