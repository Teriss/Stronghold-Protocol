import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../public/js/render/vfx/wiring.js';
import { graphicRotation, setIndexVersion, skinPoint } from '../public/js/render/vfx/mounts.js';

const OUTFIT = 'char_1033_swire2@ambienceSynesthesia#4';
const OTHER = 'char_test_target@winter#5';
const LATE = 'char_test_target@nlc#1';
const HIT = 'swire2_attack_hit';
const HIT_SKIN = 'swire2_attack_hit [alt-1]#4';
const mount = (x, y, z) => ({ pos: [x, y, z] });
const view = (id, skin = null, x = 10) => ({ id, info: { id, spine: 'char_test', skin }, x, y: 9, z: 0 });

function fixture() {
  setIndexVersion(3);
  const src = view('caster', OUTFIT);
  const tgt = view('target', OTHER, 14);
  const targetBack = mount(0.5, 0.25, -0.75);
  const baseGraphic = { rot: [0, 0, 0, 1] };
  const idx = {
    version: 3,
    units: { char_test: { skin: 'base', modes: [] } },
    skins: { base: { points: { HitPoint: { all: mount(0, 0, -1) }, HeadPoint: { all: mount(0, 0, -2) } }, graphic: baseGraphic } },
    projectiles: {},
    generic: { status: { test: HIT } },
    skinFx: {
      [OUTFIT]: {
        replace: { [HIT]: HIT_SKIN, [HIT_SKIN]: 'second_hop' },
        points: { MuzzlePoint: { front: mount(1, 0, -2), back: mount(1.5, 0, -2) } },
        fakeProjectiles: { phantom: 'phantom_skin' },
      },
      [OTHER]: {
        replace: { [HIT]: 'other_hit' },
        points: { Hit: { front: mount(0.25, 0, -0.5), back: targetBack }, Head: { all: mount(0, NaN, 0) } },
        graphic: { rot: [NaN, 0, 0, 1] },
      },
      [LATE]: { replace: { late_base: 'late_variant' } },
    },
  };
  const calls = [], preload = [], warm = [];
  const defs = new Map();
  const installed = new Set([HIT, HIT_SKIN, 'other_hit', 'second_hop', 'late_base', 'late_variant', 'phantom_skin']);
  const lib = {
    index: async () => idx,
    defs,
    has: (k) => installed.has(k),
    def: (k) => defs.get(k) ?? null,
    async preload(keys) { preload.push(keys); return keys.length; },
  };
  const w = new FxWiring({
    lib, active: true, time: 0, timers: [],
    spawn(key, place, opts) {
      const h = { alive: true, anchor: place.pos.slice(), time: 0, stop() { this.alive = false; }, linkLines() {} };
      calls.push({ key, place, opts, h });
      return h;
    },
    warm: (keys) => warm.push(keys),
  });
  return { w, src, tgt, idx, calls, preload, warm, installed, defs, targetBack, baseGraphic };
}

test('uses the exact current displayed skin, and resolves only one installed hook', async () => {
  const { w, src, idx, installed } = fixture();
  await w.ready();
  src.info.sourceSkin = 'not-the-displayed-skin';
  assert.equal(w.resolveKey(src, HIT.toUpperCase()), HIT_SKIN);
  installed.delete(HIT);
  assert.equal(w.resolveKey(src, HIT), HIT_SKIN, 'an installed skin variant can be used even if the base is absent');
  installed.add(HIT);
  src.info.sourceSkin = OUTFIT;
  src.info.skin = OUTFIT.toLowerCase();
  assert.equal(w.resolveKey(src, HIT), HIT);
  src.info.skin = null;
  assert.equal(w.resolveKey(src, HIT), HIT, 'hidden preference is not the rendered skin');
  src.info.skin = OUTFIT;
  assert.equal(w.resolveKey(src, HIT), HIT_SKIN);
  delete idx.skinFx;
  assert.equal(w.resolveKey(src, HIT), HIT, 'older indexes remain compatible');
});

test('ignores missing, failed, malformed, inherited and plugin redirects', async () => {
  const { w, idx, src, installed, defs } = fixture();
  await w.ready();
  const replace = idx.skinFx[OUTFIT].replace;
  installed.delete(HIT_SKIN);
  assert.equal(w.resolveKey(src, HIT), HIT);
  installed.add(HIT_SKIN);
  defs.set(HIT_SKIN, null);
  assert.equal(w.resolveKey(src, HIT), HIT);
  defs.delete(HIT_SKIN);
  installed.add('plugin:demo/anim');
  installed.add('../raw');
  replace['plugin:demo/anim'] = HIT_SKIN;
  assert.equal(w.resolveKey(src, 'plugin:demo/anim'), 'plugin:demo/anim');
  for (const bad of [{}, ['second_hop'], 17, '../raw', 'plugin:demo/anim', 'common_empty']) {
    replace[HIT] = bad;
    assert.equal(w.resolveKey(src, HIT), HIT);
  }
  installed.add('common_empty');
  replace.common_empty = HIT_SKIN;
  assert.equal(w.resolveKey(src, HIT), 'common_empty', 'an explicit, installed empty variant is not a missing variant');
  assert.equal(w.resolveKey(src, 'common_empty'), 'common_empty', 'the existing sentinel is never redirected');
  idx.skinFx[OUTFIT].replace = Object.create({ [HIT]: HIT_SKIN });
  assert.equal(w.resolveKey(src, HIT), HIT);
  idx.skinFx = Object.create({ [OUTFIT]: { replace: { [HIT]: HIT_SKIN } } });
  assert.equal(w.resolveKey(src, HIT), HIT);
});

test('uses the caster key and the placed unit’s mounts, with validated base-mount fallback', async () => {
  const { w, src, tgt, calls, defs, targetBack, baseGraphic } = fixture();
  await w.ready();
  // It is the replacement's descriptor, not the base summary, that describes where the new effect sits.
  defs.set(HIT, { spawn: 4 });
  defs.set(HIT_SKIN, { spawn: 2, rotateType: 1, leftIsDefault: false });
  tgt._wantsBack = () => true;
  tgt.entryBack = {};
  w.playOn(HIT, tgt, { skinFrom: src, flipFrom: { x: 15 } });
  assert.equal(calls[0].key, HIT_SKIN);
  assert.deepEqual(calls[0].place.pos, [4.5, 0.25, -0.75]);
  assert.equal(calls[0].place.mirror, true, 'facing uses flipFrom, not the caster on the left');
  assert.deepEqual(skinPoint(w.skinOfView(tgt), 'hit', true).pos, targetBack.pos);
  assert.deepEqual(skinPoint(w.skinOfView(tgt), 'head', true).pos, [0, 0, -2]);
  assert.deepEqual(graphicRotation(w.skinOfView(tgt)), baseGraphic.rot);
  w.status(tgt, 'test', true);
  assert.equal(calls[1].key, 'other_hit', 'self/status effects use the placed view as their owner');
});

test('summons inherit the owner outfit hooks but keep their own mounts', async () => {
  const { w, src } = fixture();
  await w.ready();
  src.info.kind = 'token';
  assert.equal(w.resolveKey(src, HIT), HIT_SKIN);
  assert.deepEqual(skinPoint(w.skinOfView(src), 'hit', false).pos, [0, 0, -1]);
  assert.equal(skinPoint(w.skinOfView(src), 'muzzle', false), null);
});

test('preloads both sides of hooks for initial and late units, but not fake projectiles', async () => {
  const { w, src, preload, warm } = fixture();
  await w.begin([src]);
  assert.deepEqual(new Set(preload[0]), new Set([HIT, HIT_SKIN, 'second_hop']));
  assert.deepEqual(warm[0], preload[0]);
  w.more([view('late', LATE)]);
  await Promise.resolve();
  assert.deepEqual(new Set(preload[1]), new Set(['late_base', 'late_variant']));
  assert.deepEqual(warm[1], preload[1]);
  assert.equal(w.resolveKey(src, 'phantom'), null);
});

test('projectile body, rope and impact inherit the caster skin without changing the flight', async () => {
  const { w, src, tgt, calls, idx, installed } = fixture();
  await w.ready();
  for (const key of ['body', 'rope', 'start_target', 'reached']) {
    idx.skinFx[OUTFIT].replace[key] = `${key}_skin`;
    installed.add(key).add(`${key}_skin`);
  }
  const proj = { main: 'body', behaviours: [{ class: 'HarpoonRenderer', fields: { _mainEffect: 'rope' } }], toTargetOnStart: ['start_target'], onHit: [HIT], onReached: ['reached'] };
  assert.equal(w._fly(proj, src, tgt, 'shot', 0, { dur: 1 }), 1);
  assert.deepEqual(calls.map((c) => c.key), ['start_target_skin', 'body_skin', 'rope_skin']);
  const [, body, rope] = calls;
  assert.deepEqual(body.place.pos, [1, 0, -2]);
  rope.h.time = 0.5;
  rope.opts.track(rope.h);
  body.h.time = 1;
  body.opts.track(body.h);
  assert.deepEqual(calls.slice(3).map((c) => c.key), [HIT_SKIN, 'reached_skin']);
  assert.deepEqual(calls[4].place.pos, [4.25, 0, -0.5]);
});

test('chain bounces keep the original caster skin and the bounce source direction', async () => {
  const { w, src, tgt, calls, idx, installed, defs } = fixture();
  await w.ready();
  idx.skinFx[OUTFIT].replace.chain_line = 'chain_skin';
  installed.add('chain_line').add('chain_skin');
  defs.set(HIT_SKIN, { spawn: 2, rotateType: 1, leftIsDefault: false });
  const next = view('next', null, 12);
  w.chains.set(tgt.id, { src, line: 'chain_line', proj: {}, rows: [{ k: HIT }], at: 0, until: 1 });
  assert.equal(w.chain(tgt, next, 'chain', 0), true);
  assert.deepEqual(calls.map((c) => c.key), ['chain_skin', HIT_SKIN]);
  assert.deepEqual(calls[0].place.pos, [4.25, 0, -0.5]);
  assert.equal(calls[1].place.mirror, true, 'the previous target is on the right; the caster is on the left');
});

test('legacy index shifts affect base-mount fallback but never skin-specific points', async () => {
  const { w, src, idx } = fixture();
  await w.ready();
  setIndexVersion(1);
  idx.skins.base.points.HitPoint = { all: mount(4, 0, -1) };
  assert.deepEqual(skinPoint(w.skinOfView(src), 'hit', false).pos, [0, 0.9, -1]);
  assert.deepEqual(skinPoint(w.skinOfView(src), 'muzzle', false).pos, [1, 0, -2]);
});
