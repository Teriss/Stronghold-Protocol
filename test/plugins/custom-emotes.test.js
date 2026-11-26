import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOTE_THEMES, isEmoteKey, isCustomEmoteId, makeCustomEmoteId, parseCustomEmoteId,
} from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import {
  readAssetOverlay, prepareVisualDoc, layVisualOps, customEmoteIdsFromOps, visualHashOf, writesHashOf,
} from '../../shared/plugins/visual.js';
import { sha256Hex } from '../../shared/sha256.js';
import {
  customEmoteThemes, allEmoteThemes, resolveEmoteInfo, emoteArtUrls, parseAnimatedImageDurationMs,
} from '../../public/js/ui/emotes.js';
import { activeBubbles } from '../../public/js/ui/gameLogic/watch.js';
import { createPlugin, templateById } from '../../server/studio/templates/index.js';
import { validatePresentation, presentationOptions, emotesOverlay } from '../../public/studio/js/presentation.js';
import { createPreviewLayers } from '../../public/studio/js/preview/layers.js';
import { wireOptions } from '../../server/match/host/proxy.js';
import { readPolicy } from '../../server/plugins/policy.js';
import { isEmotePlugin } from '../../server/plugins/serverEmotes.js';
import { buildPluginIndex } from '../../shared/plugins/manifest.js';
import { isPersonalCosmetic } from '../../public/js/content.js';
import { Match } from '../../server/match/Match.js';
import { loadData } from '../../server/data.js';

describe('custom emote ids & protocol', () => {
  test('validates and parses custom:<packKey>:<slotKey> wire ids', () => {
    assert.equal(isEmoteKey('pack-1'), true);
    assert.equal(isEmoteKey('my_pack_01'), true);
    assert.equal(isEmoteKey('BadUpper'), false);
    assert.equal(isEmoteKey('has:colon'), false);
    assert.equal(isEmoteKey(''), false);

    const id = makeCustomEmoteId('pack-1', 'happy');
    assert.equal(id, 'custom:pack-1:happy');
    assert.equal(isCustomEmoteId(id), true);
    assert.deepEqual(parseCustomEmoteId(id), { packKey: 'pack-1', slotKey: 'happy' });
    assert.equal(isCustomEmoteId('custom:pack-1:Bad'), false);
    assert.equal(parseCustomEmoteId('autochess_battle_happy'), null);
  });

  test('protocol accepts valid custom emote ids and rejects malformed ones', () => {
    assert.equal(validateC2S({ t: 'g.emote', id: 'custom:pack-1:happy' }), null);
    assert.ok(typeof validateC2S({ t: 'g.emote', id: 'custom:BAD:happy' }) === 'string');
    assert.ok(typeof validateC2S({ t: 'g.emote', id: 'custom:pack-1' }) === 'string');
  });
});

describe('visual overlay & client custom emote resolution', () => {
  test('readAssetOverlay, customEmoteIdsFromOps, prepareVisualDoc and client UI helpers work end-to-end', () => {
    const overlay = {
      emotes: {
        'meme-pack': {
          name: '整活表情包',
          slots: {
            laugh: { label: '大笑', image: 'emotes/meme-pack/laugh.png' },
            blank_label: { label: '', image: 'emotes/meme-pack/blank.webp' },
          },
        },
      },
    };
    const read = readAssetOverlay(overlay, { permissions: ['assets.add'] });
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.warnings, []);
    assert.deepEqual(customEmoteIdsFromOps(read.ops), [
      'custom:meme-pack:laugh',
      'custom:meme-pack:blank_label',
    ]);

    const files = {
      'emotes/meme-pack/laugh.png': sha256Hex('laugh'),
      'emotes/meme-pack/blank.webp': sha256Hex('blank'),
    };
    const overlays = [{ id: 'my-emotes', version: '1.0.0', files, writes: writesHashOf(read.ops) }];
    const vs = visualHashOf({ assets: sha256Hex('assets'), overlays });
    const doc = { visual: { v: 2, vs, assets: sha256Hex('assets'), overlays }, writes: [{ id: 'my-emotes', ops: read.ops }] };
    const prep = prepareVisualDoc(doc);
    assert.equal(prep.droppedCount, 0);
    const { manifest } = layVisualOps({}, [prep]);

    const customThemes = customEmoteThemes(manifest);
    assert.equal(customThemes.length, 1);
    assert.equal(customThemes[0].themeId, 'custom:meme-pack');
    assert.equal(customThemes[0].name, '整活表情包');
    assert.equal(customThemes[0].emotes.length, 2);
    assert.equal(customThemes[0].emotes[0].id, 'custom:meme-pack:laugh');
    assert.equal(customThemes[0].emotes[1].label, 'blank_label');
    assert.equal(allEmoteThemes(manifest).length, EMOTE_THEMES.length + 1);

    const info = resolveEmoteInfo('custom:meme-pack:laugh', manifest);
    assert.equal(info?.custom, true);
    assert.equal(info?.label, '大笑');
    assert.match(emoteArtUrls('custom:meme-pack:laugh', manifest)[0], /^\/p\/my-emotes\/[0-9a-f]{8}\/emotes\/meme-pack\/laugh\.png$/);
  });

  test('enforces max 6 slots per emote pack and lowercase pack/slot keys', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`s${i}`, { label: '', image: `emotes/p/s${i}.png` }]));
    const r1 = readAssetOverlay({ emotes: { p: { name: 'Too many', slots: tooMany } } });
    assert.ok(r1.problems.some((p) => /more than 6/.test(p)));

    const r2 = readAssetOverlay({ emotes: { BadKey: { name: 'Bad', slots: {} } } });
    assert.ok(r2.problems.length > 0);
  });
});

describe('Match server-side custom emote authorization', () => {
  test('allows room custom emotes only when enabled in opts.customEmotes', () => {
    const broadcasted = [];
    const baseOpts = {
      matchId: 'm1',
      mode: 'solo',
      difficulty: 'FUNNY',
      seed: 1,
      data: loadData(),
      seats: [{ playerId: 'p1', name: 'P1', isBot: false }],
      send: () => true,
      broadcast: (msg) => broadcasted.push(msg),
      onEnd: () => {},
    };
    const vanilla = new Match(baseOpts);
    const pVanilla = vanilla.players.get('p1');
    assert.ok(vanilla.emote(pVanilla, 'custom:pack-1:slot-1').error);

    const modded = new Match({ ...baseOpts, customEmotes: ['custom:pack-1:slot-1'] });
    const pModded = modded.players.get('p1');
    assert.equal(modded.emote(pModded, 'custom:pack-1:slot-1').ok, true);
    assert.equal(broadcasted.some((m) => m.t === 'm.emote' && m.id === 'custom:pack-1:slot-1'), true);
    assert.ok(modded.emote(pModded, 'custom:pack-1:other').error);
  });
});

describe('Studio emotes template', () => {
  test('creates a valid emote pack plugin with sample image and passes presentation validation', () => {
    const tpl = templateById('emotes');
    assert.ok(tpl);
    const made = createPlugin(tpl, { id: 'fun-emotes', name: '趣味表情包' });
    assert.equal(made.manifest.class, 'cosmetic');
    assert.deepEqual(made.manifest.permissions, ['assets.add']);
    assert.ok(made.files['emotes/pack-1/slot-1.png'] instanceof Uint8Array);
    const opts = presentationOptions('emotes', made.authoring.options);
    assert.equal(validatePresentation({ template: 'emotes', id: 'fun-emotes', options: opts }).ok, true);

    const overlay = emotesOverlay(opts.packs);
    assert.equal(overlay.emotes['pack-1'].slots['slot-1'].image, 'emotes/pack-1/slot-1.png');
  });

  test('preview layers keep custom emotes when targets is empty', () => {
    const layers = createPreviewLayers();
    layers.set([
      { at: ['emotes', 'jiuren-1', 'name'], value: '疚刃 1' },
      { at: ['emotes', 'jiuren-1', 'slots', 'slot-1', 'image'], value: '/studio/api/plugins/jiuren-emotes/f/deadbeef/emotes/jiuren-1/slot-1.webp' },
    ], []);
    const merged = layers.apply({});
    assert.equal(merged.emotes['jiuren-1'].slots['slot-1'].image, '/studio/api/plugins/jiuren-emotes/f/deadbeef/emotes/jiuren-1/slot-1.webp');
  });

  test('wireOptions forwards customEmotes to hosted matches and omits it when absent', () => {
    const plain = wireOptions({ roomCode: 'ABCD', mode: 'solo', customEmotes: [] });
    assert.equal('customEmotes' in plain, false);
    const modded = wireOptions({ roomCode: 'ABCD', mode: 'solo', customEmotes: ['custom:jiuren-1:slot-1'] });
    assert.deepEqual(modded.customEmotes, ['custom:jiuren-1:slot-1']);
  });

  test('server-wide emote policy, emotesOnly catalogue flag, and live Match.setCustomEmotes', () => {
    const pol = readPolicy({ emotes: ['jiuren-emotes', 'jiuren-emotes'] });
    assert.deepEqual(pol.problems, []);
    assert.deepEqual(pol.policy.emotes, ['jiuren-emotes']);

    const fakePlugin = {
      id: 'jiuren-emotes',
      class: 'cosmetic',
      status: 'loaded',
      source: 'plugins',
      manifest: {
        manifest: 2, name: '疚刃', englishName: '', names: { zh: '疚刃' }, description: {},
        version: '1.0.0', app: '>=0.4.0 <0.5.0', compatible: true, api: 2, scope: ['room'],
        authors: [], credits: '', license: '', homepage: '', requires: {}, optional: {}, conflicts: {},
        loadAfter: [], loadBefore: [], priority: 0, settings: {}, permissions: ['assets.add'],
      },
      visual: {
        vs: 'a'.repeat(64),
        bytes: 1024,
        ops: [{ at: ['emotes', 'jiuren-1', 'slots', 'slot-1', 'image'], file: 'emotes/jiuren-1/slot-1.webp' }],
      },
    };
    assert.equal(isEmotePlugin(fakePlugin), true);
    const idx = buildPluginIndex([fakePlugin]);
    assert.equal(idx.plugins[0].emotesOnly, true);
    assert.equal(isPersonalCosmetic(idx.plugins[0]), false);

    const broadcasted = [];
    const match = new Match({
      matchId: 'm2', mode: 'solo', difficulty: 'FUNNY', seed: 2, data: loadData(),
      seats: [{ playerId: 'p1', name: 'P1', isBot: false }],
      send: () => true, broadcast: (msg) => broadcasted.push(msg), onEnd: () => {},
    });
    const p1 = match.players.get('p1');
    assert.ok(match.emote(p1, 'custom:jiuren-1:slot-1').error);
    match.setCustomEmotes(['custom:jiuren-1:slot-1']);
    assert.equal(match.emote(p1, 'custom:jiuren-1:slot-1').ok, true);
    assert.equal(broadcasted.some((m) => m.t === 'm.emote' && m.id === 'custom:jiuren-1:slot-1'), true);
  });

  test('parseAnimatedImageDurationMs reads WebP ANMF and APNG fcTL durations and activeBubbles honors per-emote ttl', () => {
    const anmf = (ms) => {
      const buf = new Uint8Array(8 + 16);
      buf.set([0x41, 0x4e, 0x4d, 0x46], 0); // ANMF
      buf[4] = 16; // size = 16
      buf[8 + 12] = ms & 0xff;
      buf[8 + 13] = (ms >> 8) & 0xff;
      buf[8 + 14] = (ms >> 16) & 0xff;
      return buf;
    };
    const f1 = anmf(100);
    const f2 = anmf(250);
    const webp = new Uint8Array(12 + f1.length + f2.length);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    webp.set(f1, 12);
    webp.set(f2, 12 + f1.length);
    assert.equal(parseAnimatedImageDurationMs(webp), 350);

    const fctl = (num, den) => {
      const buf = new Uint8Array(12 + 26);
      buf[3] = 26;
      buf.set([0x66, 0x63, 0x54, 0x4c], 4); // fcTL
      buf[8 + 20] = (num >> 8) & 0xff; buf[8 + 21] = num & 0xff;
      buf[8 + 22] = (den >> 8) & 0xff; buf[8 + 23] = den & 0xff;
      return buf;
    };
    const p1 = fctl(1, 10);
    const p2 = fctl(3, 10);
    const apng = new Uint8Array(8 + p1.length + p2.length);
    apng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    apng.set(p1, 8);
    apng.set(p2, 8 + p1.length);
    assert.equal(parseAnimatedImageDurationMs(apng), 400);

    assert.equal(parseAnimatedImageDurationMs(new Uint8Array(32)), null);

    const m = activeBubbles(
      [
        { seq: 1, playerId: 'p1', id: 'custom:jiuren-1:slot-1', at: 1000 },
        { seq: 2, playerId: 'p2', id: 'autochess_battle_happy', at: 1000 },
      ],
      6000,
      3000,
      (id) => (id === 'custom:jiuren-1:slot-1' ? 7400 : 3000),
    );
    assert.equal(m.get('p1')?.ttl, 7400);
    assert.equal(m.has('p2'), false);
  });
});
