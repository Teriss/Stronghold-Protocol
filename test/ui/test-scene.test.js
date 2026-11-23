import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../../server/data.js';
import * as spec from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { makeRunner } from '../../public/js/battle/localPlayback.js';
import { BATTLE_CAP, DEFAULT_STAGE, editScene, emptyScene, hasCombatants, sceneSpec, sceneStages, sceneTerrain } from '../../public/js/battle/testSceneModel.js';

const raw = loadData();
const sim = { raw, ds: new DataSource(raw, null), spec };
const chess = 'chess_char_1_02_a';
const equipment = 'chess_item_1_01_e_a';
const walker = 'enemy_1000_gopro_2';
const flyer = 'enemy_1005_yokai';
const context = { sim, config: raw.config, terrain: sceneTerrain(sim, DEFAULT_STAGE) };

function edit(scene, action) {
  const result = editScene(scene, action, context);
  assert.ok(result.scene, result.error);
  return result.scene;
}

test('all normal maps have a goal and a ground route in the actual simulation', () => {
  const stages = sceneStages(raw.stages);
  assert.equal(stages.length, 8);
  for (const stage of stages) {
    const { grid, goal } = sceneTerrain(sim, stage.id);
    assert.ok(grid.findPath(...grid.specialTiles('start')[0], ...goal), stage.id);
  }
});

test('scene spec spawns enemies at the placed tiles and carries equipped items into a deterministic battle', () => {
  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  assert.equal(hasCombatants(scene), false);
  scene = edit(scene, { type: 'equip', uid: 2, target: 1 });
  scene = edit(scene, { type: 'deploy', uid: 1, row: 10, col: 4 });
  scene = edit(scene, { type: 'face', uid: 1, dir: 'LEFT' });
  scene = edit(scene, { type: 'enemy', id: walker, row: 9, col: 8 });
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  const setup = structuredClone(scene);
  const input = sceneSpec(sim, scene, context.terrain.goal);
  const run = () => {
    const battle = spec.createBattleFromSpec(input, sim.ds, { quiet: true });
    battle.step();
    assert.deepEqual(battle.enemies.map(e => [e.defId, e.spawnY, e.spawnX]), [[walker, 9, 8]]);
    const units = battle.allyUnits.filter(u => u.kind === 'op');
    assert.equal(units.length, 1);
    assert.deepEqual(units[0].items, [equipment]);
    assert.equal(units[0].dir, 'LEFT');
    const distance = battle.remainingDistance(battle.enemies[0]);
    for (let i = 0; i < 30; i++) battle.step();
    assert.ok(battle.remainingDistance(battle.enemies[0]) < distance);
    assert.deepEqual(battle.errors, []);
    return battle.snapshot();
  };
  assert.deepEqual(run(), run());
  assert.deepEqual(scene, setup);
});

test('placement, retreat and bench edits reject unusable targets atomically', () => {
  let scene = emptyScene();
  for (let i = 0; i < GEO.HAND_SIZE; i++) scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  const reject = (action, message) => assert.deepEqual(editScene(scene, action, context), { error: message });
  reject({ type: 'add', kind: 'item', id: equipment }, '整备区已满');
  reject({ type: 'deploy', uid: 1, row: 8, col: 6 }, '无法部署在该位置');
  reject({ type: 'enemy', id: walker, row: 9, col: 5 }, '敌人无法从该位置前往蓝门');
  reject({ type: 'enemy', id: walker, row: 9, col: 2 }, '无法放置在该位置');
  const reservedKey = [...context.terrain.reserved][0];
  const [resRow, resCol] = [Math.floor(reservedKey / 21), reservedKey % 21];
  reject({ type: 'enemy', id: flyer, row: resRow, col: resCol }, '该位置已有单位');
  const airborne = edit(scene, { type: 'enemy', id: flyer, row: 9, col: 5 });
  assert.equal(sceneSpec(sim, airborne, context.terrain.goal).spawns[0].route.motion, 'FLY');
  scene = edit(scene, { type: 'deploy', uid: 1, row: 10, col: 4 });
  reject({ type: 'enemy', id: walker, row: 10, col: 4 }, '该位置已有单位');
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  reject({ type: 'retreat', uid: 1 }, '整备区已满');
  assert.equal(scene.board[0].uid, 1);
  assert.equal(scene.hand.filter(Boolean).length, GEO.HAND_SIZE);
});

test('deployed operators respect equipment capacity, unequip, retreat and removal', () => {
  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  scene = edit(scene, { type: 'deploy', uid: 1, row: 10, col: 4 });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  scene = edit(scene, { type: 'equip', uid: 2, target: 1 });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  scene = edit(scene, { type: 'equip', uid: 3, target: 1 });
  assert.equal(scene.board[0].items.length, 2);
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  const beforeFull = structuredClone(scene);
  assert.deepEqual(editScene(scene, { type: 'equip', uid: 4, target: 1 }, context), { error: '该干员的装备栏已满' });
  assert.deepEqual(scene, beforeFull);

  scene = edit(scene, { type: 'unequip', uid: 1, itemUid: 2 });
  assert.equal(scene.board[0].items.length, 1);
  assert.equal(scene.hand.filter(Boolean).length, 2);
  scene = edit(scene, { type: 'retreat', uid: 1 });
  assert.equal(scene.board.length, 0);
  const benched = scene.hand.find(p => p?.uid === 1);
  assert.equal(benched.items.length, 1);

  scene = edit(scene, { type: 'enemy', id: walker, row: 9, col: 8 });
  assert.equal(scene.enemies.length, 1);
  scene = edit(scene, { type: 'remove', uid: scene.enemies[0].uid });
  assert.equal(scene.enemies.length, 0);
  scene = edit(scene, { type: 'remove', uid: 1 });
  assert.equal(scene.hand.find(p => p?.uid === 1), undefined);
});

test('single-side scenes run enemy routes to completion and cap operator-only scenes at 240s', () => {
  let enemyOnly = emptyScene();
  enemyOnly = edit(enemyOnly, { type: 'enemy', id: flyer, row: 9, col: 5 });
  assert.equal(hasCombatants(enemyOnly), true);
  const flyBattle = spec.createBattleFromSpec(sceneSpec(sim, enemyOnly, context.terrain.goal), sim.ds, { quiet: true });
  flyBattle.step();
  assert.deepEqual(flyBattle.enemies.map(e => [e.defId, e.spawnY, e.spawnX]), [[flyer, 9, 5]]);
  const d0 = flyBattle.remainingDistance(flyBattle.enemies[0]);
  for (let i = 0; i < 30; i++) flyBattle.step();
  assert.ok(flyBattle.remainingDistance(flyBattle.enemies[0]) < d0);
  flyBattle.runToEnd(BATTLE_CAP);
  assert.equal(flyBattle.finished, true);
  assert.equal(flyBattle.leakedCount, 1);
  assert.equal(flyBattle.total, 1);

  let opOnly = emptyScene();
  opOnly = edit(opOnly, { type: 'add', kind: 'chess', id: chess });
  opOnly = edit(opOnly, { type: 'deploy', uid: 1, row: 10, col: 4 });
  assert.equal(hasCombatants(opOnly), true);
  const opBattle = spec.createBattleFromSpec(sceneSpec(sim, opOnly, context.terrain.goal), sim.ds, { quiet: true });
  opBattle.autoFinish = false;
  const runner = makeRunner(opBattle, { cap: BATTLE_CAP });
  runner.play();
  for (let i = 0; i < BATTLE_CAP * 5 + 5 && !opBattle.finished; i++) runner.advance(0.2);
  assert.equal(opBattle.finished, true);
  assert.equal(opBattle.reason, 'timeout');
  assert.ok(Math.abs(opBattle.time - BATTLE_CAP) < 1e-6);
});
