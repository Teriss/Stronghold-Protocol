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
import { mergeLocalSkins } from '../server/plugins/artReferences.js';
import { createPluginRegistry, readVanillaAssets } from '../server/plugins/registry.js';
import { layVisualOps } from '../shared/plugins/visual.js';

const root = '/assets/local/skins/';
const img = `${root}cosmetics/art.png`;
const sk = 'A-1#outfit+';
const model = (name) => {
  const stem = `${root}cosmetics/${name}`;
  return { skel: `${stem}/model.skel`, atlas: `${stem}/model.atlas`, textures: [`${stem}/page.png`],
    pma: false, anims: { idle: 'Idle' }, animations: { Idle: 1 }, events: { Idle: ['hit'] },
    hits: { Idle: [0.25] }, bounds: { Idle: [0, 0, 1, 1] } };
};
const front = model('front');
const back = model('back');
const original = {
  chars: { char_1_a: { avatar: '/assets/base.png', skins: { base: { name: '原', group: '原系列', avatar: '/assets/base-skin.png' } } }, char_2_b: {} },
  tokens: { token_1_a: { spineLocal: { path: 'original' } } },
};
const sidecar = (name = '本地') => ({ version: 1,
  chars: { char_1_a: { skins: { [sk]: { name, group: '系列', avatar: img } } } },
  tokens: { token_1_a: { skins: { [sk]: { name, group: '', spine: { front, back } } } } },
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-local-skins-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), publicDir = path.join(dir, 'public');
  const pluginsDir = path.join(dir, 'plugins'), packsDir = path.join(dir, 'packs'), sharedDir = path.join(dir, 'shared');
  const write = async (abs, bytes) => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  };
  const side = path.join(dataDir, 'local-skins.json');
  const save = (doc) => write(side, JSON.stringify(doc));
  await write(path.join(dataDir, 'assets.json'), JSON.stringify(original, null, 2));
  return { dataDir, publicDir, pluginsDir, packsDir, sharedDir, side, save, write };
}

const doc = (view) => JSON.parse(view.body);

test('local skin additions preserve installed slots and do not create chars or tokens', () => {
  const local = sidecar();
  local.chars.char_1_a.skins.base = { name: 'not a replacement', group: 'none', avatar: img, portrait: img };
  local.chars.unknown = local.chars.char_1_a;
  local.tokens.unknown = local.tokens.token_1_a;
  const merged = mergeLocalSkins(original, local);
  assert.equal(merged.chars.unknown, undefined);
  assert.equal(merged.tokens.unknown, undefined);
  assert.deepEqual(merged.chars.char_1_a.skins.base, { ...original.chars.char_1_a.skins.base, portrait: img });
  assert.equal(merged.chars.char_1_a.avatar, original.chars.char_1_a.avatar);
  assert.equal(original.chars.char_1_a.skins[sk], undefined);
  assert.equal(merged.tokens.token_1_a.spineLocal, original.tokens.token_1_a.spineLocal);
  assert.deepEqual(merged.tokens.token_1_a.skins[sk].spine, { front, back });
});

test('unsafe target keys, art URLs, and nested metadata cannot escape the local boundary', () => {
  const local = sidecar();
  const strip = local.chars.char_1_a.skins;
  const unsafe = ['/assets/official.png', `${root}../art.png`, `${root}a%2fb.png`, `${root}a%252fb.png`,
    `${root}%2e%2e/a.png`, `${root}dir\\b.png`, `${root}a.png?x`, `${root}a.png#tag`, `${root}/a.png`, `${root}aux.png`];
  for (const [i, url] of unsafe.entries()) strip[`bad${i}`] = { name: 'bad', group: '', avatar: url };
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'a/b']) {
    Object.defineProperty(strip, key, { value: strip[sk], enumerable: true });
  }
  const evil = JSON.parse('{"Idle":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"ok":1}}');
  local.tokens.token_1_a.skins[sk].spine = { front: { ...front, hits: evil }, back: { ...back, atlas: front.atlas } };
  local.tokens.token_1_a.skins.invalidPages = { name: 'bad', group: '', spine: { front: { ...front, textures: [img] } } };
  const merged = mergeLocalSkins(original, local);
  assert.deepEqual(Object.keys(merged.chars.char_1_a.skins), ['base', sk]);
  assert.deepEqual(merged.tokens.token_1_a.skins[sk].spine, { front: { ...front, hits: { Idle: { ok: 1 } } } });
  assert.equal(merged.tokens.token_1_a.skins.invalidPages, undefined);
  assert.equal({}.polluted, undefined);
});

test('plain served view tracks sidecar add, replacement, invalid version, corruption, and deletion', async (t) => {
  const f = await fixture(t);
  const views = createManifestViews({ dataDir: f.dataDir });
  const assets = () => views.get('assets.json');
  assert.equal(await assets(), null);
  await f.save(sidecar());
  const first = await assets();
  assert.equal(doc(first).chars.char_1_a.skins[sk].avatar, img);
  assert.equal(await assets(), first);
  const replacement = f.side + '.replacement';
  const timestamp = (await fs.stat(f.side)).mtime;
  await f.write(replacement, JSON.stringify(sidecar('替换')));
  await fs.utimes(replacement, timestamp, timestamp);
  await fs.rename(replacement, f.side);
  const second = await assets();
  assert.notEqual(second.hash, first.hash);
  assert.equal(doc(second).chars.char_1_a.skins[sk].name, '替换');
  await f.save({ ...sidecar(), version: 2 });
  assert.equal(await assets(), null);
  await f.write(f.side, '{ broken');
  assert.equal(await assets(), null);
  await f.save(sidecar());
  assert.equal((await assets()).hash, first.hash);
  await fs.unlink(f.side);
  assert.equal(await assets(), null);
});

test('indexed local images and model members serve at both plain and hashed URLs', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.save(sidecar());
  const files = [img, front.skel, front.atlas, ...front.textures, back.skel, back.atlas, ...back.textures];
  for (const url of files) await f.write(path.join(f.publicDir, url), url);
  const index = createAssetIndex({ publicDir: f.publicDir, rescanGapMs: 0 });
  const views = createManifestViews({ dataDir: f.dataDir, index });
  t.after(() => index.close());
  const serve = createStaticHandler({ ...f, assetIndex: index, views });
  const server = createServer((req, res) => serve(req, res, req.url, '').catch(() => { res.statusCode = 500; res.end(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (url) => fetch(`http://127.0.0.1:${server.address().port}${url}`);
  const assets = async () => (await get('/data/assets.json')).json();
  assert.equal((await assets()).chars.char_1_a.skins[sk].avatar, img);
  await index.refresh();
  const rewritten = await assets();
  const scene = rewritten.tokens.token_1_a.skins[sk].spine;
  const hashPart = (url) => /^(\/assets\/~[0-9a-f]{16})\//.exec(url)?.[1];
  for (const [source, target] of [[front, scene.front], [back, scene.back]]) {
    const prefix = hashPart(target.skel);
    assert.ok(prefix);
    assert.equal(hashPart(target.atlas), prefix);
    assert.equal(hashPart(target.textures[0]), prefix);
    assert.deepEqual(target.hits, source.hits);
  }
  const hashed = [rewritten.chars.char_1_a.skins[sk].avatar, scene.front.skel, scene.front.atlas, ...scene.front.textures,
    scene.back.skel, scene.back.atlas, ...scene.back.textures];
  for (const [i, url] of files.entries()) {
    assert.ok(hashPart(hashed[i]));
    const plain = await get(url);
    const immutable = await get(hashed[i]);
    assert.equal(plain.status, 200);
    assert.equal(immutable.status, 200);
    assert.equal(await plain.text(), url);
    assert.equal(await immutable.text(), url);
    assert.match(immutable.headers.get('cache-control'), /immutable/);
  }
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error('local index did not refresh')); }, 3000);
    const off = index.onChange(() => { clearTimeout(timeout); off(); resolve(); });
  });
  await f.write(path.join(f.publicDir, img), 'updated image bytes');
  await f.save(sidecar('已更新'));
  await assets(); // Seeing a changed sidecar schedules the usual index rescan, even before an asset request.
  await changed;
  const after = (await assets()).chars.char_1_a.skins[sk];
  assert.equal(after.name, '已更新');
  assert.notEqual(after.avatar, hashed[0]);
  assert.equal(await (await get(after.avatar)).text(), 'updated image bytes');
});

test('plugin registry can reference local skins; cosmetic writes win without changing base identity', async (t) => {
  const f = await fixture(t);
  const registry = createPluginRegistry(f, { recheckMs: 0 });
  const pluginDir = path.join(f.pluginsDir, 'local-test');
  await f.write(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    manifest: 2, id: 'local-test', name: 'Local test', version: '0.1.0', app: '>=0.4.0 <0.5.0', api: 1,
    class: 'cosmetic', scope: ['personal'], authors: ['Test'], license: 'CC0-1.0', permissions: ['assets.override'],
    assets: { chars: { char_2_b: { skins: { [sk]: { avatar: { ref: 'char_1_a' } } } },
      char_1_a: { skins: { [sk]: { name: 'Plugin wins' } } } } },
  }));
  const sha = readVanillaAssets(f.dataDir).sha256;
  assert.equal(registry.plugin('local-test'), null);
  await f.save(sidecar());
  const plugin = registry.plugin('local-test');
  assert.ok(plugin, JSON.stringify(registry.pluginIndex()));
  const vanilla = registry.vanillaAssets();
  assert.equal(vanilla.sha256, sha);
  assert.deepEqual(vanilla.baseManifest, original);
  const applied = layVisualOps(vanilla.manifest, [{ ops: plugin.visual.ops.map((op) => op.text !== undefined ? { at: op.at, value: op.text } : op) }]);
  assert.deepEqual(applied.dropped, []);
  assert.equal(applied.manifest.chars.char_2_b.skins[sk].avatar, img);
  assert.equal(applied.manifest.chars.char_1_a.skins[sk].name, 'Plugin wins');
  await fs.unlink(f.side);
  assert.equal(registry.plugin('local-test'), null);
  assert.equal(registry.vanillaAssets().sha256, sha);
});
