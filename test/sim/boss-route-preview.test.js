import test from 'node:test';
import assert from 'node:assert/strict';
import { getVersionData } from '../../server/data.js';
import { Battle } from '../../server/sim/Battle.js';
import { buildBossRoutePreview } from '../../server/sim/bossRoutePreview.js';
import { DataSource, getDefaultSource } from '../../server/sim/simdata.js';

const covenant = getDefaultSource();
const regulation = new DataSource(getVersionData('act3autochess@V3_1'));
const hunt = 'enemy_9017_achunt';
const pair = [{ playerId: 'left', side: 'L' }, { playerId: 'right', side: 'R' }];
const quiet = { log() {}, warn() {}, error() {} };

function bossOptions(data, waveId, stageId, kind = 'boss') {
  const wave = data.getWave(waveId);
  const spawns = wave.spawns.filter((s) => s.tag === 'boss').map((s) => ({ ...s, enemyKey: s.key }));
  return { kind, waveId, stageId, players: pair, routes: wave.routes, spawns, enemyOverrides: wave.overrides };
}

function preview(data, opts, side = 'L') {
  return buildBossRoutePreview({ ...opts, side }, data);
}

function onPath(e, path) {
  return path.points.slice(1).some(([r, c], i) => {
    const [r0, c0] = path.points[i];
    const cross = (r - r0) * (e.x - c0) - (c - c0) * (e.y - r0);
    const within = (e.y - r0) * (e.y - r) + (e.x - c0) * (e.x - c);
    return Math.abs(cross) < 1e-7 && within < 1e-7;
  });
}

test('Regulation hunt follows each real patrol branch from the shared spawn', () => {
  const opts = bossOptions(regulation, 'act3autochess_h07_02', 'act3autochess_m01');
  const left = preview(regulation, opts, 'L');
  const right = preview(regulation, opts, 'R');
  assert.deepEqual(left.paths[0], { kind: 'approach', points: [[4, 10], [5, 9]] });
  assert.deepEqual(right.paths[0], { kind: 'approach', points: [[4, 10], [3, 11]] });
  assert.deepEqual(left.marks.map(({ at }) => at), [[5, 9], [2, 3], [3, 9]]);
  assert.deepEqual(right.marks.map(({ at }) => at), [[3, 11], [2, 17], [5, 11]]);
  assert.ok(right.paths[1].points.every(([, col]) => col > 10));

  const b = new Battle({ ...opts, data: regulation, recordEvents: false, logger: quiet });
  const sampled = { left: 0, right: 0 };
  for (let i = 0; i < 180; i++) {
    b.step();
    for (const e of b.enemies) {
      if (e.route.legIdx >= 2) continue;
      const side = e.mem.mirror ? 'right' : 'left';
      const route = side === 'right' ? right : left;
      assert.ok(onPath(e, route.paths[e.route.legIdx]), `${side} step ${i} at ${e.y},${e.x}`);
      sampled[side]++;
    }
  }
  assert.ok(sampled.left > 30 && sampled.right > 30, 'the live leaders both walked the preview');
});

test('mirror uses the version gate and does not duplicate an already scheduled copy', () => {
  const waveId = 'act3autochess_h07_02';
  const opts = bossOptions(regulation, waveId, 'act3autochess_m01');
  const right = preview(regulation, opts, 'R');
  const wave = regulation.getWave(waveId);
  const s = wave.branches.boss_battle_multi_player[0][0];
  const spawn = { enemyKey: s.key, time: s.time, route: wave.extraRoutes[s.routeIndex], tag: 'boss' };
  assert.deepEqual(preview(regulation, { ...opts, spawns: [...opts.spawns, spawn] }, 'R'), right);
  assert.equal(preview(regulation, { ...opts, bossMirror: false }, 'R'), null);

  const raw = regulation.raw;
  const version = { ...raw.config.version, rules: { ...raw.config.version.rules, bossMirrorShare: false } };
  const withoutMirror = new DataSource({ ...raw, config: { ...raw.config, version } });
  assert.equal(preview(withoutMirror, opts, 'R'), null);
});

test('Lucien closes one visible patrol while keeping a genuine return in both directions', () => {
  const opts = bossOptions(covenant, 'act2autochess_h07_05', 'act1autochess_m01');
  const { paths, marks } = preview(covenant, opts);
  assert.deepEqual(paths[0], { kind: 'approach', points: [[4, 10], [3, 9]] });
  assert.equal(paths.length, 2);
  const patrol = paths[1];
  assert.equal(patrol.kind, 'patrol');
  assert.deepEqual(patrol.points[0], patrol.points.at(-1));
  const edges = patrol.points.slice(1).map((point, i) => `${patrol.points[i]}/${point}`);
  assert.equal(edges.length, new Set(edges).size);
  assert.ok(edges.includes('2,4/2,3') && edges.includes('2,3/2,4'));
  assert.deepEqual(marks, [[3, 9], [2, 3], [5, 9]].map((at) => ({ kind: 'waypoint', at })));
});

test('moving Regulation leaders and Hidden Core use their selected template and version', () => {
  for (const [suffix, kind, first] of [
    ['h07_10', 'boss', [3, 11]],
    ['h07_11', 'boss', [5, 11]],
    ['h08_02', 'hidden', [3, 11]],
    ['h08_06', 'hidden', [3, 11]],
  ]) {
    const opts = bossOptions(regulation, `act3autochess_${suffix}`, 'act3autochess_m01', kind);
    assert.deepEqual(preview(regulation, opts, 'R').marks[0], { kind: 'waypoint', at: first });
  }
  const opts = bossOptions(covenant, 'act1autochess_h08_02', 'act1autochess_m01', 'hidden');
  assert.equal(preview(covenant, opts, 'R').paths[0].kind, 'approach');
});

test('initial device overrides affect only the correct half and respect the battle terrain', () => {
  const opts = bossOptions(covenant, 'act1autochess_h07_02', 'act1autochess_m04');
  const left = preview(covenant, opts);
  const right = preview(covenant, opts, 'R');
  const params = Object.fromEntries(['201', '202', '203', '301', '302', '303'].map((suffix) => [`trap_1105_accrate#${suffix}`, false]));
  const changed = { ...opts, players: [{ ...pair[0], playerEffects: [{ params }] }, pair[1]] };
  const changedLeft = preview(covenant, changed);
  assert.notDeepEqual(changedLeft.paths, left.paths);
  assert.deepEqual(changedLeft.marks, left.marks);
  assert.deepEqual(preview(covenant, changed, 'R'), right);
  assert.deepEqual(preview(covenant, opts), left, 'preparing an altered field leaves ordinary terrain intact');

  const platform = bossOptions(regulation, 'act3autochess_h07_02', 'act3autochess_m03');
  const deviceOverrides = Object.fromEntries(regulation.getStage(platform.stageId).devices
    .filter((d) => d.role === 'platform' && d.col < 10).map((d) => [d.raw.alias, false]));
  const modified = { ...platform, players: [{ ...pair[0], deviceOverrides }, pair[1]] };
  assert.notDeepEqual(preview(regulation, modified).paths, preview(regulation, platform).paths);
});

const openStage = { id: 'open', rows: Array(6).fill('r'.repeat(21)) };
function customOptions(route, enemyKey = hunt) {
  return { kind: 'boss', stage: openStage, routes: [route], players: pair, spawns: [{ time: 0, enemyKey, tag: 'boss' }] };
}

test('fly travel crosses both halves, marks long stops, and breaks the line at a portal', () => {
  const route = { start: [2, 8], end: [4, 15], steps: [
    { t: 'move', p: [2, 9] }, { t: 'wait', s: 2 }, { t: 'disappear' }, { t: 'wait', s: 1 },
    { t: 'move', p: [4, 13] }, { t: 'wait', s: 0.1 },
  ] };
  const wall = { key: 'trap_1106_achplat', role: 'platform', row: 4, col: 14 };
  const opts = { ...customOptions(route, 'enemy_1005_yokai'), stage: { ...openStage, devices: [wall] } };
  const left = preview(covenant, opts);
  assert.deepEqual(left, {
    paths: [{ kind: 'travel', points: [[2, 8], [2, 9]] }, { kind: 'travel', points: [[4, 13], [4, 15]] }],
    marks: [
      { kind: 'waypoint', at: [2, 9] }, { kind: 'wait', at: [2, 9] }, { kind: 'portal', at: [2, 9] },
      { kind: 'portal', at: [4, 13] }, { kind: 'waypoint', at: [4, 13] },
    ],
  });
  assert.deepEqual(preview(covenant, opts, 'R'), left, 'a shared leader that travels on both halves is relevant to both');
});

test('bound, motionless, zero-speed and unselected leaders have no preview', () => {
  const bound = bossOptions(covenant, 'act1autochess_h07_01', 'act1autochess_m01');
  assert.equal(preview(covenant, bound), null);
  const gear = bossOptions(regulation, 'act3autochess_h07_08', 'act3autochess_m01');
  assert.equal(preview(regulation, gear), null);
  const walker = bossOptions(covenant, 'act1autochess_h07_02', 'act1autochess_m01');
  assert.equal(preview(covenant, { ...walker, enemyOverrides: { [hunt]: { stats: { moveSpeed: 0 } } } }), null);
  assert.equal(preview(covenant, { ...walker, spawns: [] }), null);
  assert.equal(preview(covenant, { ...walker, kind: 'normal' }), null);
});
