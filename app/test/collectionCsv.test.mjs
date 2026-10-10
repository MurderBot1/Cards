import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, sniffDelimiter, toCsv } from '../js/csv.js';
import {
  detectFormat, exportCollectionCsv, exportFileName, isFoilValue, mapColumns, normalizeCondition, normalizeGame,
  normalizeLanguage, parseCollectionCsv,
} from '../js/collectionCsv.js';

test('CSV reading: quotes, line breaks, odd separators, BOM and blank lines', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('﻿name,count\n"Bolt, Lightning","He said ""hi"""\n'), [['name', 'count'], ['Bolt, Lightning', 'He said "hi"']]);
  assert.deepEqual(parseCsv('a,b\n"line\nbreak",2'), [['a', 'b'], ['line\nbreak', '2']]);
  assert.deepEqual(parseCsv('a;b\n1;2\n'), [['a', 'b'], ['1', '2']], 'semicolons');
  assert.deepEqual(parseCsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']], 'tabs');
  assert.deepEqual(parseCsv('a,b\n\n\n1,2\n\n'), [['a', 'b'], ['1', '2']], 'blank lines dropped');
  assert.deepEqual(parseCsv('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']], 'empty fields kept');
  assert.deepEqual(parseCsv('a,b\n"",x'), [['a', 'b'], ['', 'x']]);
  assert.deepEqual(parseCsv(''), []);
  assert.equal(sniffDelimiter('"a;b",c;d,e\n1,2'), ',', 'separators inside quotes do not count');
});

test('CSV writing quotes what needs it and round-trips', () => {
  const rows = [['Count', 'Name'], [2, 'Bolt, Lightning'], [1, 'Say "hi"'], [1, 'two\nlines'], [null, undefined], [' padded ', 'x']];
  const text = toCsv(rows);
  assert.equal(text.split('\r\n')[1], '2,"Bolt, Lightning"');
  assert.deepEqual(parseCsv(text), [['Count', 'Name'], ['2', 'Bolt, Lightning'], ['1', 'Say "hi"'], ['1', 'two\nlines'], ['', ''], [' padded ', 'x']]);
});

test('condition words from every app land on one of the five', () => {
  const cases = {
    'Near Mint': 'Near Mint', near_mint: 'Near Mint', NM: 'Near Mint', Mint: 'Near Mint',
    'Good (Lightly Played)': 'Lightly Played', 'Lightly Played': 'Lightly Played', lightly_played: 'Lightly Played', LP: 'Lightly Played', 'Slightly Played': 'Lightly Played', Excellent: 'Lightly Played',
    Played: 'Moderately Played', 'Moderately Played': 'Moderately Played', moderately_played: 'Moderately Played', MP: 'Moderately Played',
    'Heavily Played': 'Heavily Played', heavily_played: 'Heavily Played', HP: 'Heavily Played',
    Poor: 'Damaged', Damaged: 'Damaged', DMG: 'Damaged',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeCondition(input), expected, input);
  for (const unknown of ['', 'pristine', null, undefined]) assert.equal(normalizeCondition(unknown), null);
});

test('foil, language and game values', () => {
  for (const yes of ['foil', 'Foil', 'yes', 'TRUE', '1', 'etched', 'Holofoil', 'Reverse Holofoil', '1st Edition Holofoil', 'foil_etched']) assert.equal(isFoilValue(yes), true, yes);
  for (const no of ['', 'normal', 'Normal', 'no', 'false', '0', 'nonfoil', 'Non-foil', 'Non Foil', 'regular', undefined]) assert.equal(isFoilValue(no), false, String(no));
  assert.equal(normalizeLanguage('en'), 'English');
  assert.equal(normalizeLanguage('JA'), 'Japanese');
  assert.equal(normalizeLanguage('Klingon'), 'Klingon');
  assert.equal(normalizeLanguage(''), '');
  assert.deepEqual(['Magic', 'MTG', 'Pokémon', 'pokemon', 'Yu-Gi-Oh!', 'ygo', 'Digimon', ''].map(normalizeGame), ['mtg', 'mtg', 'pokemon', 'pokemon', 'yugioh', 'yugioh', null, null]);
});

test('headers: what each column is, and which app a file looks like', () => {
  const moxfield = ['Count', 'Tradelist Count', 'Name', 'Edition', 'Condition', 'Language', 'Foil', 'Tags', 'Last Modified', 'Collector Number', 'Alter', 'Proxy', 'Purchase Price'];
  const deckbox = ['Count', 'Tradelist Count', 'Name', 'Edition', 'Card Number', 'Condition', 'Language', 'Foil', 'Signed', 'Artist Proof', 'Altered Art', 'Misprint', 'Promo', 'Textless', 'My Price'];
  const manabox = ['Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Rarity', 'Quantity', 'ManaBox ID', 'Scryfall ID', 'Purchase price', 'Misprint', 'Altered', 'Condition', 'Language', 'Purchase price currency'];
  const tcgplayer = ['Quantity', 'Name', 'Simple Name', 'Set', 'Card Number', 'Set Code', 'Printing', 'Condition', 'Language', 'Rarity', 'Product ID', 'SKU'];
  const archidekt = ['Quantity', 'Name', 'Finish', 'Condition', 'Date Added', 'Language', 'Purchase Price', 'Tags', 'Edition Name', 'Edition Code', 'Multiverse Id', 'Scryfall ID', 'Collector Number', 'Rarity'];
  assert.deepEqual([moxfield, deckbox, manabox, tcgplayer, archidekt].map(detectFormat), ['Moxfield', 'Deckbox', 'ManaBox', 'TCGplayer', 'Archidekt']);
  assert.equal(detectFormat(['Name', 'Qty']), null);
  assert.equal(detectFormat(['Count', 'Name', 'Game', 'Set Code', 'Collector Number', 'Binder ID']), 'Binder');

  const m = mapColumns(moxfield);
  assert.deepEqual([m.name, m.quantity, m.setAny, m.condition, m.foil, m.number], [2, 0, 3, 4, 6, 9], 'Tradelist Count is not the count');
  const t = mapColumns(tcgplayer);
  assert.equal(t.name, 2, 'Simple Name beats Name');
  assert.deepEqual([t.setCode, t.setAny, t.number, t.foil], [5, 3, 4, 6]);
  assert.equal(mapColumns(['Qty', 'Card Name']).quantity, 0);
});

test('Moxfield: the edition is a code', () => {
  const csv = 'Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price\n' +
    '2,0,Lightning Bolt,m11,Near Mint,English,,,2024-01-01,146,,,\n' +
    '1,1,"Sol Ring",cmr,Good (Lightly Played),Japanese,foil,,2024-01-01,472,,,\n' +
    '0,3,Counterspell,mh2,Near Mint,English,,,2024-01-01,267,,,\n';
  const r = parseCollectionCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'Moxfield');
  assert.equal(r.rows.length, 2);
  assert.equal(r.skipped, 1, 'a zero count is skipped');
  assert.deepEqual(r.rows[0], { line: 2, name: 'Lightning Bolt', quantity: 2, game: null, setCode: 'M11', setName: '', number: '146', condition: 'Near Mint', language: '', foil: false, rarity: '', scryfallId: '', binderId: '', image: '' });
  assert.deepEqual([r.rows[1].condition, r.rows[1].foil, r.rows[1].language, r.rows[1].setCode], ['Lightly Played', true, 'Japanese', 'CMR']);
});

test('Deckbox: the edition is a set name', () => {
  const csv = 'Count,Tradelist Count,Name,Edition,Card Number,Condition,Language,Foil,Signed\n' +
    '3,0,Lightning Bolt,Magic 2011,146,Near Mint,English,,\n' +
    '1,0,Sol Ring,Commander Legends,472,Played,English,foil,\n';
  const r = parseCollectionCsv(csv);
  assert.equal(r.format, 'Deckbox');
  assert.deepEqual([r.rows[0].setName, r.rows[0].setCode, r.rows[0].number], ['Magic 2011', '', '146']);
  assert.deepEqual([r.rows[1].condition, r.rows[1].foil], ['Moderately Played', true]);
});

test('ManaBox, the TCGplayer app and Archidekt', () => {
  const mana = parseCollectionCsv('Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Condition,Language\n' +
    'Lightning Bolt,M11,Magic 2011,146,normal,common,4,1234,AAAA-BBBB,near_mint,en\n' +
    'Sol Ring,CMR,Commander Legends,472,foil,uncommon,1,99,CCCC-DDDD,lightly_played,ja\n');
  assert.equal(mana.format, 'ManaBox');
  assert.deepEqual([mana.rows[0].quantity, mana.rows[0].foil, mana.rows[0].scryfallId, mana.rows[0].language, mana.rows[0].rarity], [4, false, 'aaaa-bbbb', '', 'common']);
  assert.deepEqual([mana.rows[1].foil, mana.rows[1].condition, mana.rows[1].language, mana.rows[1].setName], [true, 'Lightly Played', 'Japanese', 'Commander Legends']);

  const tcg = parseCollectionCsv('Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU\n' +
    '1,Phyrexian Defiler,Phyrexian Defiler,Urza\'s Legacy,60,ULG,Normal,Near Mint,English,Uncommon,6359,19855\n' +
    '2,Sol Ring (Borderless),Sol Ring,Commander Legends,472,CMR,Foil,Lightly Played,English,Uncommon,1,2\n');
  assert.equal(tcg.format, 'TCGplayer');
  assert.deepEqual([tcg.rows[0].name, tcg.rows[0].setCode, tcg.rows[0].setName, tcg.rows[0].number], ['Phyrexian Defiler', 'ULG', "Urza's Legacy", '60']);
  assert.deepEqual([tcg.rows[1].name, tcg.rows[1].foil, tcg.rows[1].quantity], ['Sol Ring', true, 2]);

  const arch = parseCollectionCsv('Quantity,Name,Finish,Condition,Edition Name,Edition Code,Scryfall ID,Collector Number\n1,Counterspell,Foil,NM,Modern Horizons 2,mh2,abc,267\n');
  assert.equal(arch.format, 'Archidekt');
  assert.deepEqual([arch.rows[0].foil, arch.rows[0].setCode, arch.rows[0].setName, arch.rows[0].scryfallId], [true, 'MH2', 'Modern Horizons 2', 'abc']);
});

test('what can go wrong with a file is said plainly', () => {
  assert.equal(parseCollectionCsv('').ok, false);
  assert.match(parseCollectionCsv('Foo,Bar\n1,2').error, /card name column/);
  assert.match(parseCollectionCsv('Name,Count\n,2\nBolt,0').error, /no cards/);
  const r = parseCollectionCsv('Name\nLightning Bolt\nSol Ring');
  assert.deepEqual([r.rows.length, r.rows[0].quantity, r.rows[0].condition, r.assumedCondition], [2, 1, 'Near Mint', 0], 'a name alone is enough');
  const odd = parseCollectionCsv('Name,Count,Condition\nBolt,two,pristine\nSol Ring,3,LP');
  assert.deepEqual([odd.rows[0].quantity, odd.rows[0].condition, odd.assumedCondition], [1, 'Near Mint', 1], 'junk count -> 1, unknown condition noted');
  assert.equal(parseCollectionCsv('Name,Edition\nBolt,mh2\nSol,cmr').rows[0].setCode, 'MH2', 'a short column of codes');
  assert.equal(parseCollectionCsv('Name,Edition\nBolt,Modern Horizons 2\nSol,Commander Legends').rows[0].setName, 'Modern Horizons 2');
});

test('exporting a collection keeps everything Binder knows and reads back the same', () => {
  const collection = { name: 'Modern, "staples"', cards: [
    { id: 'a', name: 'Lightning Bolt', game: 'mtg', set: 'M11', number: '146', rarity: 'Common', condition: 'Near Mint', quantity: 4, uid: 'mtg-aaaa-bbbb', image: 'http://x/y.jpg' },
    { id: 'b', name: 'Sol Ring', game: 'mtg', set: 'CMR', condition: 'Lightly Played', quantity: 1, foil: true, language: 'Japanese' },
    { id: 'c', name: 'Charizard', game: 'pokemon', set: 'BS', quantity: 2, uid: 'pkm-base1-4' },
  ] };
  const text = exportCollectionCsv(collection);
  const table = parseCsv(text);
  assert.deepEqual(table[0], ['Count', 'Name', 'Game', 'Set Code', 'Collector Number', 'Rarity', 'Condition', 'Foil', 'Language', 'Binder ID', 'Scryfall ID', 'Image URL', 'Collection']);
  assert.deepEqual(table[1], ['4', 'Lightning Bolt', 'mtg', 'M11', '146', 'Common', 'Near Mint', '', 'English', 'mtg-aaaa-bbbb', 'aaaa-bbbb', 'http://x/y.jpg', 'Modern, "staples"']);
  assert.deepEqual([table[2][7], table[2][8], table[2][6]], ['foil', 'Japanese', 'Lightly Played']);
  assert.equal(table[1][8], 'English', 'no language stored means English');
  assert.equal(table[3][10], '', 'a Scryfall id only for Magic cards');

  const back = parseCollectionCsv(text);
  assert.equal(back.format, 'Binder');
  assert.equal(back.rows.length, 3);
  assert.deepEqual([back.rows[0].game, back.rows[0].binderId, back.rows[0].scryfallId, back.rows[0].number], ['mtg', 'mtg-aaaa-bbbb', 'aaaa-bbbb', '146']);
  assert.deepEqual([back.rows[1].foil, back.rows[1].condition, back.rows[2].game], [true, 'Lightly Played', 'pokemon']);
  assert.equal(exportCollectionCsv({ name: 'Empty', cards: [] }).trim(), table[0].join(','));
});

test('file names for exports', () => {
  assert.equal(exportFileName('My Binder'), 'My Binder.csv');
  assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij.csv');
  assert.equal(exportFileName('   '), 'Binder collection.csv');
  assert.equal(exportFileName(null), 'Binder collection.csv');
});
