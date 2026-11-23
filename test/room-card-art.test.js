// Waiting-room card art (screens/room.js, ui/assetUrls.js roomCardPortraitUrls, server/plugins/artReferences.js
// roomArtFields): the sidecar's room field must merge into known entries only — with its binding to the picture it
// reproduces and the operator it was cropped for — and the room must draw a high-resolution card only while that
// picture is still the one this installation would draw for that operator and stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssetIndex } from '../server/http/assetIndex.js';
import { createManifestViews } from '../server/http/assetViews.js';
import { createStaticHandler } from '../server/http/static.js';
import { mergeLocalSkins, roomArtFields, roomArtUrl } from '../server/plugins/artReferences.js';
import { roomCardPortraitUrls } from '../public/js/ui/assetUrls.js';
import { seatArtSrc } from '../public/js/ui/seatArt.js';

const ROOM = '/assets/local/skins/room-cards/';
const hd = (id, name) => `${ROOM}${id}/${name}.webp`;
const old = (id) => `/assets/char/portrait/${id}_1.png`;
const old2 = (id) => `/assets/char/portrait/${id}_2.png`;

const base = () => ({
  chars: {
    char_1_a: { avatar: '/assets/char/avatar/char_1_a.png', portrait: old('char_1_a'), portraitE2: old2('char_1_a') },
    char_2_b: { avatar: '/assets/char/avatar/char_2_b.png', portrait: old('char_2_b') },
  },
  tokens: { token_1_a: {} },
});

const room = (id, name) => ({ roomPortrait: hd(id, name), roomPortraitFrom: old(id), roomPortraitOf: id });
const chess = (id, extra = {}) => ({ charId: id, assets: { portrait: `${id}_1` }, ...extra });

test('room card fields merge into a known operator with no skins, and create nothing', () => {
  const local = { version: 1, chars: {
    char_1_a: { ...room('char_1_a', 'char_1_a_1'), roomPortraitE2: hd('char_1_a', 'char_1_a_2'), roomPortraitE2From: old2('char_1_a') },
    char_9_z: room('char_9_z', 'char_9_z_1'),
  } };
  const merged = mergeLocalSkins(base(), local);
  assert.deepEqual(merged.chars.char_1_a, { ...base().chars.char_1_a, ...room('char_1_a', 'char_1_a_1'),
    roomPortraitE2: hd('char_1_a', 'char_1_a_2'), roomPortraitE2From: old2('char_1_a') });
  assert.equal(merged.chars.char_9_z, undefined);
  assert.deepEqual(merged.chars.char_2_b, base().chars.char_2_b);
  assert.equal(base().chars.char_1_a.roomPortrait, undefined);
});

test('a room card needs its own operator, a safe WebP path and the picture it reproduces', () => {
  const bad = [
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitOf: 'char_2_b' },                       // another operator's crop
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: hd('char_2_b', 'char_2_b_1') },      // … under another folder
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: `${ROOM}char_1_a/../char_2_b/x.webp` },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: `${ROOM}char_1_a/x.png` },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: `${ROOM}char_1_a/x.webp?x=1` },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: `${ROOM}char_1_a/x.webp#y` },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: `${ROOM}char_1_a/deep/x.webp` },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: `${ROOM}char_1_a/x.webp/` },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: '/assets/char/portrait/char_1_a_1.png' },
    { ...room('char_1_a', 'char_1_a_1'), roomPortrait: undefined },
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitFrom: undefined },
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitFrom: 'javascript:alert(1)' },
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitFrom: '/assets/char/../../secret.png' },
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitFrom: '/assets/char/portrait/x.png?y' },
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitFrom: 'assets/char/portrait/x.png' },
    { ...room('char_1_a', 'char_1_a_1'), roomPortraitOf: undefined },
  ];
  for (const record of bad) {
    const standalone = base();
    assert.equal(mergeLocalSkins(standalone, { version: 1, chars: { char_1_a: record } }), standalone, JSON.stringify(record));
  }
  assert.equal(roomArtUrl(hd('char_1_a', 'char_1_a_1'), 'char_1_a'), hd('char_1_a', 'char_1_a_1'));
  assert.equal(roomArtUrl(hd('char_1_a', 'char_1_a_1'), 'char_2_b'), null);
  assert.equal(roomArtFields({ ...room('char_1_a', 'char_1_a_1'), roomPortrait: 'x' }, 'char_1_a'), null);
});

test('a skin keeps its room card without creating an outfit, and installed fields win', () => {
  const key = 'char_1_a@test#1';
  const merged = mergeLocalSkins(base(), { version: 1, chars: { char_1_a: { skins: {
    [key]: { name: '常服', group: '系列', portrait: `${ROOM}x/portrait.png`,
      roomPortrait: `${ROOM}char_1_a/outfit.webp`, roomPortraitFrom: '/assets/local/skins/char_1_a/x/portrait.png',
      roomPortraitOf: 'char_1_a' },
    onlyRoom: { ...room('char_1_a', 'unhoused') },                                       // no name/group: not an outfit
  } } } });
  assert.deepEqual(merged.chars.char_1_a.skins[key], { name: '常服', group: '系列', portrait: `${ROOM}x/portrait.png`,
    roomPortrait: `${ROOM}char_1_a/outfit.webp`, roomPortraitOf: 'char_1_a',
    roomPortraitFrom: '/assets/local/skins/char_1_a/x/portrait.png' });
  assert.equal(merged.chars.char_1_a.skins.onlyRoom, undefined);

  const installed = { ...base(), chars: { ...base().chars,
    char_1_a: { ...base().chars.char_1_a, ...room('char_1_a', 'installed') } } };
  assert.equal(mergeLocalSkins(installed, { version: 1, chars: { char_1_a: room('char_1_a', 'sidecar') } }), installed);
});

test('the room draws the high-resolution card, then the outfit, then the default art', () => {
  const skin = 'char_1_a@test#1';
  const m = { chars: {
    char_1_a: {
      ...base().chars.char_1_a, ...room('char_1_a', 'char_1_a_1'),
      roomPortraitE2: hd('char_1_a', 'char_1_a_2'), roomPortraitE2From: old2('char_1_a'),
      skins: { [skin]: { name: '常服', group: '系列', portrait: '/assets/local/skins/char_1_a/x/portrait.png',
        roomPortrait: hd('char_1_a', 'outfit'), roomPortraitFrom: '/assets/local/skins/char_1_a/x/portrait.png',
        roomPortraitOf: 'char_1_a' } },
    },
  } };
  assert.deepEqual(roomCardPortraitUrls(m, chess('char_1_a')), [hd('char_1_a', 'char_1_a_1'), old('char_1_a')]);
  assert.deepEqual(roomCardPortraitUrls(m, chess('char_1_a'), { skin }), [
    hd('char_1_a', 'outfit'), '/assets/local/skins/char_1_a/x/portrait.png',
    hd('char_1_a', 'char_1_a_1'), old('char_1_a')]);
  // a skin this manifest does not hold draws the default art, whose copy still applies
  assert.deepEqual(roomCardPortraitUrls(m, chess('char_1_a'), { skin: 'char_1_a@missing#9' }),
    [hd('char_1_a', 'char_1_a_1'), old('char_1_a')]);
  // no room art at all: the picture this installation has, and the avatar frame after it
  assert.deepEqual(roomCardPortraitUrls({ chars: base().chars }, chess('char_2_b')), [old('char_2_b')]);
  assert.deepEqual(roomCardPortraitUrls(null, chess('char_2_b')), []);
});

test('an elite stage never borrows the other stage room card', () => {
  const m = { chars: { char_1_a: { ...base().chars.char_1_a, ...room('char_1_a', 'char_1_a_1') } } };
  // chess.json gives an elite piece the `_2` picture id (ui/assetUrls.js chessPortraitUrl): its copy must be the E2 one
  assert.deepEqual(roomCardPortraitUrls(m, { charId: 'char_1_a', isGolden: true, assets: { portrait: 'char_1_a_2' } }),
    [old2('char_1_a')]);
  // a golden piece whose portrait id is the character key uses portraitE2 (chessPortraitUrl's own rule)
  assert.deepEqual(roomCardPortraitUrls(m, { charId: 'char_1_a', isGolden: true, assets: {} }), [old2('char_1_a')]);
  // a non-elite piece on the same operator keeps the E1 picture and its copy
  assert.deepEqual(roomCardPortraitUrls(m, chess('char_1_a')), [hd('char_1_a', 'char_1_a_1'), old('char_1_a')]);
  // a picture shared by both stages is shared by their copies too
  const shared = { chars: { char_1_a: { portrait: old('char_1_a'), portraitE2: old('char_1_a'), ...room('char_1_a', 'char_1_a_1'),
    roomPortraitE2: hd('char_1_a', 'char_1_a_1'), roomPortraitE2From: old('char_1_a') } } };
  assert.deepEqual(roomCardPortraitUrls(shared, chess('char_1_a', { isGolden: true })), [hd('char_1_a', 'char_1_a_1'), old('char_1_a')]);
});

test('a plugin picture, or a record copied from another operator, leaves the card on the old picture', () => {
  const overridden = { chars: { char_1_a: { ...base().chars.char_1_a, portrait: '/p/plug/1/art.png',
    ...room('char_1_a', 'char_1_a_1') } } };
  assert.deepEqual(roomCardPortraitUrls(overridden, chess('char_1_a')), ['/p/plug/1/art.png']);
  // `chars.char_2_b = { "ref": "char_1_a" }`: the copy carries char_1_a's room fields under char_2_b's key
  const copied = { chars: { ...base().chars,
    char_2_b: { ...base().chars.char_1_a, portrait: old('char_1_a'), ...room('char_1_a', 'char_1_a_1') } } };
  assert.deepEqual(roomCardPortraitUrls(copied, chess('char_2_b')), [old('char_1_a')]);
  // … and the sidecar merge refuses to make it char_2_b's
  const record = { ...room('char_1_a', 'char_1_a_1'), roomPortraitOf: 'char_1_a' };
  const standalone = base();
  assert.equal(mergeLocalSkins(standalone, { version: 1, chars: { char_2_b: record } }), standalone);
});

test('a picture that failed to load is skipped in order, the avatar frame last', () => {
  const m = { chars: { char_1_a: { ...base().chars.char_1_a, ...room('char_1_a', 'char_1_a_1') } } };
  const urls = roomCardPortraitUrls(m, chess('char_1_a'));
  assert.equal(seatArtSrc(urls, []), hd('char_1_a', 'char_1_a_1'));
  assert.equal(seatArtSrc(urls, [hd('char_1_a', 'char_1_a_1')]), old('char_1_a'));
  assert.equal(seatArtSrc(urls, urls), null);
});

test('an installed room card keeps priority only while it is a valid pair', () => {
  const key = 'char_1_a@test#1';
  const outfit = { name: '常服', group: '系列', portrait: '/assets/local/skins/char_1_a/x/portrait.png' };
  const sidecar = { version: 1, chars: { char_1_a: { skins: { [key]: { ...outfit,
    roomPortrait: hd('char_1_a', 'outfit'), roomPortraitFrom: '/assets/local/skins/char_1_a/x/portrait.png',
    roomPortraitOf: 'char_1_a' } } } } };
  const withBase = (room) => ({ ...base(), chars: { ...base().chars,
    char_1_a: { ...base().chars.char_1_a, skins: { [key]: { ...outfit, ...room } } } } });

  // a valid installed pair wins, as every other merged slot does
  const good = withBase(room('char_1_a', 'installed'));
  assert.deepEqual(mergeLocalSkins(good, sidecar).chars.char_1_a.skins[key].roomPortrait, hd('char_1_a', 'installed'));
  // a broken one (no binding, not a room-cards WebP) gives way to the sidecar's validated pair
  for (const broken of [{ roomPortrait: '/assets/char/portrait/x.png', roomPortraitFrom: old('char_1_a') },
    { roomPortrait: hd('char_1_a', 'installed'), roomPortraitFrom: undefined },
    { roomPortrait: hd('char_1_a', 'installed'), roomPortraitFrom: 'https://elsewhere/x.png' }]) {
    const merged = mergeLocalSkins(withBase(broken), sidecar).chars.char_1_a.skins[key];
    assert.equal(merged.roomPortrait, hd('char_1_a', 'outfit'), JSON.stringify(broken));
    assert.equal(merged.roomPortraitFrom, '/assets/local/skins/char_1_a/x/portrait.png');
    assert.equal(merged.roomPortraitOf, 'char_1_a');
  }
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-room-card-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), publicDir = path.join(dir, 'public'), sharedDir = path.join(dir, 'shared');
  const write = async (abs, bytes) => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  };
  const url = hd('char_1_a', 'char_1_a_1'), from = old('char_1_a');
  await write(path.join(dataDir, 'assets.json'), JSON.stringify(base()));
  await write(path.join(dataDir, 'local-skins.json'), JSON.stringify({ version: 1, chars: {
    char_1_a: { roomPortrait: url, roomPortraitFrom: from, roomPortraitOf: 'char_1_a' } } }));
  for (const u of [url, from, base().chars.char_1_a.portraitE2]) await write(path.join(publicDir, u), u);
  return { dir, dataDir, publicDir, sharedDir };
}

test('the served manifest hashes the room card and the picture it reproduces alike', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const index = createAssetIndex({ publicDir: f.publicDir, rescanGapMs: 0 });
  const views = createManifestViews({ dataDir: f.dataDir, index });
  t.after(() => index.close());
  const serve = createStaticHandler({ ...f, assetIndex: index, views });
  const server = createServer((req, res) => serve(req, res, req.url, '').catch(() => { res.statusCode = 500; res.end(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (u) => fetch(`http://127.0.0.1:${server.address().port}${u}`);
  await index.refresh();
  const assets = await (await get('/data/assets.json')).json();
  const entry = assets.chars.char_1_a;
  assert.match(entry.roomPortrait, /^\/assets\/~[0-9a-f]{16}\/local\/skins\/room-cards\/char_1_a\/char_1_a_1\.webp$/);
  assert.equal(entry.roomPortraitFrom, entry.portrait);
  assert.equal(entry.roomPortraitOf, 'char_1_a');
  // the binding still names the picture the page draws: the client's check survives the hash rewrite
  assert.deepEqual(roomCardPortraitUrls(assets, chess('char_1_a')), [entry.roomPortrait, entry.portrait]);
  const image = await get(entry.roomPortrait);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('cache-control'), /immutable/);
  // an install without the picture: plain URLs, the fields still present — the page falls back, a card 404 is avoided
  const bare = await fixture(t);
  await fs.rm(path.join(bare.publicDir, hd('char_1_a', 'char_1_a_1')));
  const bareIndex = createAssetIndex({ publicDir: bare.publicDir, rescanGapMs: 0 });
  t.after(() => bareIndex.close());
  const bareViews = createManifestViews({ dataDir: bare.dataDir, index: bareIndex });
  await bareIndex.refresh();
  const plain = JSON.parse((await bareViews.get('assets.json')).body);
  assert.equal(plain.chars.char_1_a.roomPortrait, hd('char_1_a', 'char_1_a_1'));
  assert.equal(plain.chars.char_1_a.roomPortraitFrom, plain.chars.char_1_a.portrait);
  assert.deepEqual(roomCardPortraitUrls(plain, chess('char_1_a')), [hd('char_1_a', 'char_1_a_1'), plain.chars.char_1_a.portrait]);
});
