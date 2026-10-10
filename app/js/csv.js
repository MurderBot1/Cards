/**
 * csv.js
 * Reading and writing CSV (RFC 4180): quoted fields, doubled quotes, line breaks inside quotes, a byte-order mark, and
 * the semicolon or tab separators some spreadsheet programs export instead of commas.
 */

// The separator a file uses: whichever of , ; or tab is most common in its first line outside quotes (comma if none).
export function sniffDelimiter(text) {
  const first = [];
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted) first.push(ch);
  }
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const n = first.filter((c) => c === d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** The rows of a CSV text, each an array of strings. Blank lines are dropped. */
export function parseCsv(text, delimiter = null) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const sep = delimiter || sniffDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;  // the field being read started with a quote, so an empty one still counts as a value
  const endField = () => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '' || wasQuoted) rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === sep) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0 || wasQuoted) endRow();
  return rows;
}

const needsQuotes = /[",\r\n]/;

/** CSV text for rows of values (numbers and booleans are written as they print; null and undefined as empty). */
export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value === null || value === undefined ? '' : String(value);
          return needsQuotes.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(',')
    )
    .join('\r\n') + '\r\n';
}
