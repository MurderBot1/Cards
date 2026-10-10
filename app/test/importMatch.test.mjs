import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCollectionCsv } from '../js/collectionCsv.js';
import { buildCards, identifiersFor, matchMagicRows } from '../js/importMatch.js';

const ID1 = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A little Scryfall: three cards, found by id, by set + number, by name + set, or by name.
const DB = [
  { id: ID1, name: 'Lightning Bolt', set: 'm11', collector_number: '146', rarity: 'common', image_uris: { small: 'bolt.jpg' } },
  { id: ID2, name: 'Sol Ring', set: 'cmr', collector_number: '472', rarity: 'uncommon', image_uris: { small: 'ring.jpg' } },
  { id: '33333333-3333-3333-3333-333333333333', name: 'Delver of Secrets // Insectile Aberration', set: 'isd', collector_number: '51', rarity: 'common', card_faces: [{ image_uris: { small: 'delver.jpg' } }, {}] },
];
function scryfall(calls) {
  return async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/sets')) return reply({ data: [{ name: 'Magic 2011', code: 'm11' }, { name: 'Commander Legends', code: 'cmr' }] });
    const { identifiers } = JSON.parse(init.body);
    const data = [];
    for (const q of identifiers) {
      const hit = DB.find((c) =>
        q.id ? c.id === q.id
        : q.collector_number ? c.set === q.set && c.collector_number === q.collector_number
        : q.set ? c.set === q.set && c.name.toLowerCase().startsWith(q.name.toLowerCase())
        : c.name.toLowerCase().startsWith(q.name.toLowerCase()));
      if (hit && !data.includes(hit)) data.push(hit);
    }
    return reply({ data, not_found: [] });
  };
}

test('which identifiers could find a row, most exact first', () => {
  const row = { name: 'Bolt', scryfallId: ID1, binderId: '', setCode: 'M11', setName: '', number: '146' };
  assert.deepEqual(identifiersFor(row), [{ id: ID1 }, { set: 'm11', collector_number: '146' }, { name: 'Bolt', set: 'm11' }, { name: 'Bolt' }]);
  assert.deepEqual(identifiersFor({ name: 'Bolt', scryfallId: '', binderId: `mtg-${ID2}`, setCode: '', setName: '', number: '' })[0], { id: ID2 }, "Binder's own id");
  assert.deepEqual(identifiersFor({ name: 'Bolt', scryfallId: 'not-an-id', binderId: '', setCode: '', setName: '', number: '' }), [{ name: 'Bolt' }]);
  assert.deepEqual(identifiersFor({ name: 'Bolt', scryfallId: '', binderId: '', setCode: '', setName: 'Magic 2011', number: '' }, { 'magic 2011': 'm11' }), [{ name: 'Bolt', set: 'm11' }, { name: 'Bolt' }], 'a set name turned into its code');
});

test('Magic rows are found at Scryfall, sharing requests, and fall back to less exact identifiers', async () => {
  const calls = [];
  const csv = 'Name,Set code,Collector number,Quantity,Foil,Condition,Scryfall ID\n' +
    `Lightning Bolt,M11,146,2,,near_mint,${ID1}\n` +   // by id
    'Sol Ring,CMR,472,1,foil,lightly_played,\n' +      // by set + number
    'Sol Ring,CMR,999,1,,near_mint,\n' +                // wrong number: falls back to name + set
    'Delver of Secrets,ISD,,1,,near_mint,\n' +          // a double-faced card by its front face
    'Nonexistent Card,XXX,1,1,,near_mint,\n';           // nowhere
  const parsed = parseCollectionCsv(csv);
  const progress = [];
  const matches = await matchMagicRows(parsed.rows, { fetchFn: scryfall(calls), onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual([...matches.keys()].sort(), [0, 1, 2, 3]);
  assert.deepEqual([matches.get(0).id, matches.get(0).set, matches.get(0).number, matches.get(0).rarity, matches.get(0).image], [`mtg-${ID1}`, 'M11', '146', 'Common', 'bolt.jpg']);
  assert.equal(matches.get(2).id, `mtg-${ID2}`, 'found by name + set after the number failed');
  assert.equal(matches.get(3).name, 'Delver of Secrets // Insectile Aberration');
  assert.equal(matches.has(4), false);
  assert.ok(calls.length <= 4 && calls.every((u) => u.endsWith('/cards/collection')), 'a few batched requests, no per-card requests');
  assert.deepEqual(progress.at(-1), [4, 5]);
});

test('a file with set names asks Scryfall for the set codes', async () => {
  const calls = [];
  const parsed = parseCollectionCsv('Count,Name,Edition,Card Number\n1,Lightning Bolt,Magic 2011,146\n1,Sol Ring,Commander Legends,\n');
  const matches = await matchMagicRows(parsed.rows, { fetchFn: scryfall(calls) });
  assert.ok(calls.some((u) => u.endsWith('/sets')));
  assert.deepEqual([matches.get(0).set, matches.get(1).set], ['M11', 'CMR']);
});

test('offline: nothing is found, nothing throws', async () => {
  const parsed = parseCollectionCsv('Name\nLightning Bolt\n');
  const matches = await matchMagicRows(parsed.rows, { fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(matches.size, 0);
});

test('building the cards to store', () => {
  const parsed = parseCollectionCsv('Count,Name,Set code,Collector number,Condition,Foil,Language\n' +
    '3,Lightning Bolt,M11,146,LP,foil,ja\n' +
    '1,Mystery Card,ZZZ,5,near_mint,,\n');
  const matches = new Map([[0, { id: `mtg-${ID1}`, name: 'Lightning Bolt', set: 'M11', number: '146', rarity: 'Common', image: 'bolt.jpg', game: 'mtg' }]]);
  const [matched, unmatched] = buildCards(parsed.rows, matches);
  assert.deepEqual(matched, { name: 'Lightning Bolt', game: 'mtg', set: 'M11', rarity: 'Common', image: 'bolt.jpg', condition: 'Lightly Played', quantity: 3, number: '146', uid: `mtg-${ID1}`, foil: true, language: 'Japanese' });
  assert.deepEqual(unmatched, { name: 'Mystery Card', game: 'mtg', set: 'ZZZ', rarity: '', image: '', condition: 'Near Mint', quantity: 1, number: '5' }, 'imported as written, with nothing made up');

  // Binder's own export keeps its ids for every game; other games are imported as written
  const own = parseCollectionCsv('Count,Name,Game,Set Code,Condition,Binder ID\n2,Charizard,pokemon,BS,Near Mint,pkm-base1-4\n1,Dark Magician,yugioh,LOB,Near Mint,ygo-46986414\n1,Bolt,pokemon,X,Near Mint,mtg-wrong\n');
  const cards = buildCards(own.rows, new Map());
  assert.deepEqual([cards[0].game, cards[0].uid, cards[1].game, cards[1].uid], ['pokemon', 'pkm-base1-4', 'yugioh', 'ygo-46986414']);
  assert.equal('uid' in cards[2], false, "an id from another game isn't kept");
  // a row with no game takes the one chosen
  assert.equal(buildCards(parseCollectionCsv('Name\nPikachu\n').rows, new Map(), 'pokemon')[0].game, 'pokemon');
});
