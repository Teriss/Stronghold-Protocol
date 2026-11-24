import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../../server/data.js';
import * as spec from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { makeRunner } from '../../public/js/battle/localPlayback.js';
import { BATTLE_CAP, DEFAULT_STAGE, canPlaceInScene, chessRecordOf, editScene, emptyScene, hasCombatants, legalTilesFor, prepViewState, sceneOperators, sceneSpec, sceneStages, sceneTerrain } from '../../public/js/battle/testSceneModel.js';

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

test('in-scene helpers build prepMapChars, validate drag targets, reorder bench and highlight legal tiles', () => {
  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: 10, col: 4 }, context), true);
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: 9, col: 2 }, context), false);
  assert.equal(canPlaceInScene(scene, 2, { area: 'hand', idx: 0 }, context), true);
  scene = edit(scene, { type: 'moveHand', uid: 2, idx: 4 });
  assert.equal(scene.hand[4]?.uid, 2);
  assert.equal(scene.hand[1], null);

  scene = edit(scene, { type: 'deploy', uid: 1, row: 10, col: 4, dir: 'DOWN' });
  assert.equal(scene.board[0].dir, 'DOWN');
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: 10, col: 4 }, context), true);
  assert.equal(canPlaceInScene(scene, 2, { area: 'board', row: 10, col: 4 }, context), true);
  assert.deepEqual(legalTilesFor(scene, { uid: 2 }, context), [[10, 4]]);

  scene = edit(scene, { type: 'enemy', id: walker, row: 9, col: 8 });
  const enemyTiles = legalTilesFor(scene, { enemy: walker }, context);
  assert.ok(enemyTiles.some(([r, c]) => r === 9 && c === 9));
  assert.ok(!enemyTiles.some(([r, c]) => r === 9 && c === 8));
  assert.ok(!enemyTiles.some(([r, c]) => r === 9 && c === 2));

  const prep = prepViewState(scene, p => `name:${p.id}`);
  assert.equal(prep.prepMapChars.length, 1);
  assert.deepEqual(
    [prep.prepMapChars[0].uid, prep.prepMapChars[0].defId, prep.prepMapChars[0].y, prep.prepMapChars[0].x, prep.prepMapChars[0].side],
    [scene.enemies[0].uid, walker, 9, 8, 'enemy'],
  );
});

test('catalogue includes DIY operators (normal & elite) with accurate placement, equipment rules and battle simulation', () => {
  const ops = sceneOperators(raw);
  const chenNormal = ops.find(op => op.charId === 'char_1050_chen3' && !op.golden);
  const chenElite = ops.find(op => op.charId === 'char_1050_chen3' && op.golden);
  const rangedDiy = ops.find(op => op.isDiy && !op.golden && op.rec.position === 'RANGED');
  assert.ok(chenNormal && chenElite, '赤刃明霄陈 normal & elite are listed');
  assert.equal(chenNormal.rec.name, '赤刃明霄陈');
  assert.ok(rangedDiy, 'a ranged DIY operator is listed');
  assert.equal(ops.filter(op => op.isDiy).length, 180, 'all 90 DIY operators in normal and elite forms');

  const m03 = 'act1autochess_m03';
  const m03Ctx = { sim, config: raw.config, terrain: sceneTerrain(sim, m03) };
  const editM03 = (s, action) => {
    const result = editScene(s, action, m03Ctx);
    assert.ok(result.scene, result.error);
    return result.scene;
  };
  const [highRow, highCol] = raw.stages[m03].deployTiles.normal.rangedOnly[0];
  const [lowRow, lowCol] = raw.stages[m03].deployTiles.normal.melee.find(([r, c]) => !m03Ctx.terrain.reserved.has(m03Ctx.terrain.grid.key(r, c)));

  let scene = emptyScene(m03);
  scene = editM03(scene, { type: 'add', kind: 'chess', id: chenElite.id, diy: chenElite.diy });
  scene = editM03(scene, { type: 'add', kind: 'chess', id: rangedDiy.id, diy: rangedDiy.diy });
  assert.equal(chessRecordOf(raw, scene.hand[0])?.name, '赤刃明霄陈');
  assert.equal(chessRecordOf(raw, scene.hand[1])?.position, 'RANGED');

  // MELEE DIY (赤刃明霄陈) cannot deploy on a ranged-only high-ground tile, while RANGED DIY can.
  assert.deepEqual(editScene(scene, { type: 'deploy', uid: 1, row: highRow, col: highCol }, m03Ctx), { error: '无法部署在该位置' });
  scene = editM03(scene, { type: 'deploy', uid: 1, row: lowRow, col: lowCol, dir: 'RIGHT' });
  scene = editM03(scene, { type: 'deploy', uid: 2, row: highRow, col: highCol, dir: 'RIGHT' });
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: highRow, col: highCol }, m03Ctx), false, 'melee DIY cannot swap onto high ground');

  // Items that forbid DIY operators are refused on DIY pieces.
  const noDiyItem = Object.keys(raw.items).find(id => raw.items[id]?.noDiy && raw.items[id]?.itemType === 'EQUIP' && !raw.items[id]?.kind?.startsWith('consume_on_equip'));
  if (noDiyItem) {
    scene = editM03(scene, { type: 'add', kind: 'item', id: noDiyItem });
    const itemUid = scene.hand.find(p => p?.id === noDiyItem).uid;
    assert.deepEqual(editScene(scene, { type: 'equip', uid: itemUid, target: 1 }, m03Ctx), { error: '无法装备给自选干员' });
    assert.equal(canPlaceInScene(scene, itemUid, { area: 'board', row: lowRow, col: lowCol }, m03Ctx), false);
    assert.deepEqual(legalTilesFor(scene, { uid: itemUid }, m03Ctx), []);
  }

  // Regular equipment equips normally and both distinct DIY operators simulate cleanly together.
  scene = editM03(scene, { type: 'add', kind: 'item', id: equipment });
  const eqUid = scene.hand.find(p => p?.id === equipment).uid;
  scene = editM03(scene, { type: 'equip', uid: eqUid, target: 1 });
  const enemyTile = legalTilesFor(scene, { enemy: walker }, m03Ctx)[0];
  scene = editM03(scene, { type: 'enemy', id: walker, row: enemyTile[0], col: enemyTile[1] });

  const battle = spec.createBattleFromSpec(sceneSpec(sim, scene, m03Ctx.terrain.goal), sim.ds, { quiet: true });
  for (let i = 0; i < 60; i++) battle.step();
  assert.deepEqual(battle.errors, []);
  const allyChars = battle.allyUnits.filter(u => u.kind === 'op').map(u => u.def.charId).sort();
  assert.deepEqual(allyChars, ['char_1050_chen3', rangedDiy.charId].sort());
});
