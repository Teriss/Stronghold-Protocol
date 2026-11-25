import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadData } from '../../server/data.js';
import * as spec from '../../server/sim/spec.js';
import { buildBossRoutePreview } from '../../server/sim/bossRoutePreview.js';
import { DataSource } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { makeRunner } from '../../public/js/battle/localPlayback.js';
import { MODULE_NONE, loadoutOptions } from '../../shared/protocol.js';
import { applySavedLoadout, BATTLE_CAP, DEFAULT_STAGE, bossWaveConfig, canPlaceInScene, chessRecordOf, defaultModeOf, defaultStageOf, editScene, emptyScene, equipNeedsReplace, hasCombatants, legalTilesFor, matchesCatalogueQuery, operatorBondNames, pieceConfigState, pieceLoadoutMap, pieceOpsMap, placeableTokensOf, prepViewState, sceneBondList, sceneBondSnapshot, sceneOperators, sceneSpec, sceneStages, sceneTerrain, stageBosses } from '../../public/js/battle/testSceneModel.js';

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

test('placement, retreat, bench and equipment-area edits reject unusable targets atomically', () => {
  let scene = emptyScene();
  for (let i = 0; i < GEO.HAND_SIZE; i++) scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  const reject = (action, message) => assert.deepEqual(editScene(scene, action, context), { error: message });
  reject({ type: 'add', kind: 'chess', id: chess }, '整备区已满');
  for (let i = 0; i < GEO.TEMP_SIZE; i++) scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  assert.equal(scene.temp.filter(Boolean).length, GEO.TEMP_SIZE);
  reject({ type: 'add', kind: 'item', id: equipment }, '装备区已满');
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
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  reject({ type: 'retreat', uid: 1 }, '整备区已满');
  assert.equal(scene.board[0].uid, 1);
  assert.equal(scene.hand.filter(Boolean).length, GEO.HAND_SIZE);
});

test('deployed operators respect equipment capacity, replace, unequip to temp, retreat and removal', () => {
  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  scene = edit(scene, { type: 'deploy', uid: 1, row: 10, col: 4 });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  assert.equal(scene.temp[0]?.uid, 2, 'equipment is added to the equipment area (temp)');
  assert.equal(scene.hand.filter(Boolean).length, 0, 'operator bench stays empty');
  scene = edit(scene, { type: 'equip', uid: 2, target: 1 });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  scene = edit(scene, { type: 'equip', uid: 3, target: 1 });
  assert.equal(scene.board[0].items.length, 2);
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  assert.equal(equipNeedsReplace(scene, 4, 1, context), true);
  const beforeFull = structuredClone(scene);
  assert.deepEqual(editScene(scene, { type: 'equip', uid: 4, target: 1 }, context), { error: '该干员的装备栏已满' });
  assert.deepEqual(scene, beforeFull);

  // Explicit replacement swaps the chosen equipped item out.
  const replaced = edit(scene, { type: 'equip', uid: 4, target: 1, replaceUid: 2 });
  assert.deepEqual(replaced.board[0].items.map(it => it.uid), [4, 3]);

  scene = edit(scene, { type: 'unequip', uid: 1, itemUid: 2 });
  assert.equal(scene.board[0].items.length, 1);
  assert.equal(scene.temp.filter(Boolean).length, 2, 'unequipped item returns to equipment area');
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

test('in-scene helpers build prepMapChars, validate drag targets, reorder bench/temp and highlight legal tiles', () => {
  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: chess });
  scene = edit(scene, { type: 'add', kind: 'item', id: equipment });
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: 10, col: 4 }, context), true);
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: 9, col: 2 }, context), false);
  assert.equal(canPlaceInScene(scene, 1, { area: 'temp', idx: 0 }, context), false, 'operators cannot drop into equipment area');
  assert.equal(canPlaceInScene(scene, 2, { area: 'hand', idx: 0 }, context), true, 'equipment can equip bench operator');
  assert.equal(canPlaceInScene(scene, 2, { area: 'hand', idx: 1 }, context), false, 'equipment cannot drop onto empty bench slot');
  assert.equal(canPlaceInScene(scene, 2, { area: 'temp', idx: 3 }, context), true);
  scene = edit(scene, { type: 'moveTemp', uid: 2, idx: 3 });
  assert.equal(scene.temp[3]?.uid, 2);
  assert.equal(scene.temp[0], null);
  scene = edit(scene, { type: 'moveHand', uid: 1, idx: 4 });
  assert.equal(scene.hand[4]?.uid, 1);
  assert.equal(scene.hand[0], null);

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
  assert.equal(prep.equipHand, true);
  assert.equal(prep.temp[3]?.uid, 2);
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
  assert.deepEqual(editScene(scene, { type: 'deploy', uid: 1, row: highRow, col: highCol }, m03Ctx), { error: '近战单位只能部署在地面' });
  scene = editM03(scene, { type: 'deploy', uid: 1, row: lowRow, col: lowCol, dir: 'RIGHT' });
  scene = editM03(scene, { type: 'deploy', uid: 2, row: highRow, col: highCol, dir: 'RIGHT' });
  assert.equal(canPlaceInScene(scene, 1, { area: 'board', row: highRow, col: highCol }, m03Ctx), false, 'melee DIY cannot swap onto high ground');

  // Items that forbid DIY operators are refused on DIY pieces.
  const noDiyItem = Object.keys(raw.items).find(id => raw.items[id]?.noDiy && raw.items[id]?.itemType === 'EQUIP' && !raw.items[id]?.kind?.startsWith('consume_on_equip'));
  if (noDiyItem) {
    scene = editM03(scene, { type: 'add', kind: 'item', id: noDiyItem });
    const itemUid = scene.temp.find(p => p?.id === noDiyItem).uid;
    assert.deepEqual(editScene(scene, { type: 'equip', uid: itemUid, target: 1 }, m03Ctx), { error: '无法装备给自选干员' });
    assert.equal(canPlaceInScene(scene, itemUid, { area: 'board', row: lowRow, col: lowCol }, m03Ctx), false);
    assert.deepEqual(legalTilesFor(scene, { uid: itemUid }, m03Ctx), []);
  }

  // Regular equipment equips normally and both distinct DIY operators simulate cleanly together.
  scene = editM03(scene, { type: 'add', kind: 'item', id: equipment });
  const eqUid = scene.temp.find(p => p?.id === equipment).uid;
  scene = editM03(scene, { type: 'equip', uid: eqUid, target: 1 });
  const enemyTile = legalTilesFor(scene, { enemy: walker }, m03Ctx)[0];
  scene = editM03(scene, { type: 'enemy', id: walker, row: enemyTile[0], col: enemyTile[1] });

  const battle = spec.createBattleFromSpec(sceneSpec(sim, scene, m03Ctx.terrain.goal), sim.ds, { quiet: true });
  for (let i = 0; i < 60; i++) battle.step();
  assert.deepEqual(battle.errors, []);
  const allyChars = battle.allyUnits.filter(u => u.kind === 'op').map(u => u.def.charId).sort();
  assert.deepEqual(allyChars, ['char_1050_chen3', rangedDiy.charId].sort());
});

test('bonds compute officially, layers edit up to 999, and active bond effects apply in combat', () => {
  // Pick 2 distinct operators sharing the 精准 (preciShip, threshold 2) bond to activate it and verify real stat boost in combat.
  const preciOps = Object.values(raw.chess).filter(c => c && !c.isGolden && !c.isDiy && Array.isArray(c.bonds) && c.bonds.includes('preciShip'));
  assert.ok(preciOps.length >= 2, 'at least two preciShip operators exist');
  const [opA, opB] = preciOps;
  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: opA.chessId });
  scene = edit(scene, { type: 'add', kind: 'chess', id: opB.chessId });
  const tileA = legalTilesFor(scene, { uid: 1 }, context)[0];
  scene = edit(scene, { type: 'deploy', uid: 1, row: tileA[0], col: tileA[1], dir: 'RIGHT' });
  const tileB = legalTilesFor(scene, { uid: 2 }, context).find(([r, c]) => r !== tileA[0] || c !== tileA[1]);
  scene = edit(scene, { type: 'deploy', uid: 2, row: tileB[0], col: tileB[1], dir: 'RIGHT' });

  const list0 = sceneBondList(raw, scene);
  const preci0 = list0.find(b => b.bondId === 'preciShip');
  assert.ok(preci0 && preci0.active && preci0.count >= 2 && preci0.layers === 0);

  // Editing bond layers clamps to 0..999 and rejects noStack bonds (绝技).
  assert.deepEqual(editScene(scene, { type: 'setBondLayers', bondId: 'suntShip', layers: 50 }, context), { error: '该盟约不支持修改层数' });
  scene = edit(scene, { type: 'setBondLayers', bondId: 'preciShip', layers: 2000 });
  assert.equal(scene.bondLayers.preciShip, 999);
  scene = edit(scene, { type: 'setBondLayers', bondId: 'preciShip', layers: 200 });
  assert.equal(sceneBondSnapshot(raw, scene).preciShip.layers, 200);

  const spec0 = sceneSpec(sim, { ...scene, bondLayers: { preciShip: 0 } }, context.terrain.goal, { config: raw.config, bosses: raw.bosses });
  const spec200 = sceneSpec(sim, scene, context.terrain.goal, { config: raw.config, bosses: raw.bosses });
  assert.equal(spec200.players[0].bonds.preciShip.layers, 200);
  assert.equal(spec200.players[0].units[0].potential, 6);
  assert.equal(spec200.players[0].units[0].cultivate, 3);

  const b0 = spec.createBattleFromSpec(spec0, sim.ds, { quiet: true });
  const b200 = spec.createBattleFromSpec(spec200, sim.ds, { quiet: true });
  b0.step();
  b200.step();
  const atk0 = b0.allyUnits.find(u => u.uid === 1)._s.atk;
  const atk200 = b200.allyUnits.find(u => u.uid === 1)._s.atk;
  assert.ok(atk200 > atk0, `200-layer preciShip boosts ATK (${atk200} > ${atk0})`);
});

test('boss-exclusive fields disable custom enemy placement and run authentic boss waves, routes and HP pools', () => {
  const bossTerrain = sceneTerrain(sim, DEFAULT_STAGE, 'boss');
  assert.deepEqual(bossTerrain.goal, [2, 2]);
  const bossCtx = { sim, config: raw.config, bosses: raw.bosses, terrain: bossTerrain };
  const editBoss = (s, action) => {
    const result = editScene(s, action, bossCtx);
    assert.ok(result.scene, result.error);
    return result.scene;
  };
  const chenElite = sceneOperators(raw).find(op => op.charId === 'char_1050_chen3' && op.golden);
  let scene = emptyScene(DEFAULT_STAGE, 'boss');
  scene = editBoss(scene, { type: 'add', kind: 'chess', id: chenElite.id, diy: chenElite.diy });
  scene = editBoss(scene, { type: 'deploy', uid: 1, row: 10, col: 4, dir: 'RIGHT' });

  // Custom enemy placement is disabled in Boss stage scenes.
  assert.deepEqual(
    editScene(scene, { type: 'enemy', id: walker, row: 10, col: 9 }, bossCtx),
    { error: 'Boss 战场景不可自定义摆放敌人，请在敌人列表中选择 Boss' },
  );
  assert.deepEqual(legalTilesFor(scene, { enemy: walker }, bossCtx), []);

  // Stage boss options come from official data: 战场#01 supports FUNNY (no hidden) and NORMAL (with hidden).
  const normalInfo = stageBosses(raw, raw.config, raw.bosses, DEFAULT_STAGE, 'mode_single_normal');
  assert.equal(normalInfo.modeId, 'mode_single_normal');
  assert.ok(normalInfo.bosses.some(b => b.bossId === 'boss_1' && !b.hidden));
  assert.ok(normalInfo.bosses.some(b => b.bossId === 'boss_8' && b.hidden));
  const funnyInfo = stageBosses(raw, raw.config, raw.bosses, DEFAULT_STAGE, 'mode_single_funny');
  assert.equal(funnyInfo.bosses.some(b => b.hidden), false, '标准难度不包含隐秘核心 Boss');

  // Selecting boss_1 (假想敌：胄) builds the official wave template, routes, and shared boss HP pool.
  scene = editBoss(scene, { type: 'selectBoss', bossModeId: 'mode_single_normal', bossId: 'boss_1' });
  const cfg1 = bossWaveConfig(raw, raw.config, raw.bosses, scene);
  assert.equal(cfg1.templateId, 'act1autochess_h07_01_s');
  assert.equal(cfg1.poolHp, raw.bosses.boss_1.bloodPoint.NORMAL);

  const bspec = sceneSpec(sim, scene, bossTerrain.goal, { config: raw.config, bosses: raw.bosses });
  assert.equal(bspec.kind, 'boss');
  assert.equal(bspec.bossId, 'boss_1');
  assert.equal(bspec.waveId, 'act1autochess_h07_01_s');
  assert.equal(bspec.boss.poolMax, raw.bosses.boss_1.bloodPoint.NORMAL);
  assert.deepEqual(bspec.rect, GEO.BOSS_RECT);
  assert.ok(bspec.routes.length >= 6);
  assert.ok(bspec.spawns.some(s => s.enemyKey === 'enemy_9013_acstmk' && s.tag === 'boss'));

  const battle = spec.createBattleFromSpec(bspec, sim.ds, { quiet: true });
  for (let i = 0; i < 60; i++) battle.step();
  assert.deepEqual(battle.errors, []);
  const ally = battle.allyUnits.find(u => u.kind === 'op');
  assert.deepEqual([ally.def.charId, ally.y, ally.x], ['char_1050_chen3', 3, 4]);
  assert.ok(battle.enemies.some(e => e.defId === 'enemy_9013_acstmk'));
  assert.equal(battle.sharedBoss.maxHp, raw.bosses.boss_1.bloodPoint.NORMAL);

  // Selecting hidden boss (boss_8) uses kind: 'hidden', round 15, and spawns boss parts.
  scene = editBoss(scene, { type: 'selectBoss', bossModeId: 'mode_single_normal', bossId: 'boss_8' });
  const hspec = sceneSpec(sim, scene, bossTerrain.goal, { config: raw.config, bosses: raw.bosses });
  assert.equal(hspec.kind, 'hidden');
  assert.equal(hspec.round, 15);
  assert.ok(hspec.spawns.some(s => s.tag === 'part'));
  const hbattle = spec.createBattleFromSpec(hspec, sim.ds, { quiet: true });
  for (let i = 0; i < 30; i++) hbattle.step();
  assert.deepEqual(hbattle.errors, []);
});

test('regulation version (规程·序列Ⅰ) includes 云迹, 规程 maps, and 规程 bosses', () => {
  const dir = 'data/versions/act3autochess-v3_1';
  const loadJson = name => JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
  const vRaw = Object.fromEntries(
    ['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups', 'config', 'bosses']
      .map(n => [n, loadJson(n)]),
  );
  const vSim = { raw: vRaw, ds: new DataSource(vRaw, null), spec };
  const ops = sceneOperators(vRaw);
  const yunjiNormal = ops.find(op => op.charId === 'char_4165_ctrail' && !op.golden);
  const yunjiElite = ops.find(op => op.charId === 'char_4165_ctrail' && op.golden);
  assert.ok(yunjiNormal && yunjiElite, '云迹 normal & elite are present in 规程·序列Ⅰ');
  assert.equal(yunjiNormal.rec.name, '云迹');

  const stages = sceneStages(vRaw.stages);
  assert.equal(stages.length, 10);
  assert.equal(defaultStageOf(stages), 'act3autochess_m01');
  assert.equal(defaultModeOf(vRaw.config), 'mode_single_5');

  const bossStage = 'act3autochess_m02';
  const bossInfo = stageBosses(vRaw, vRaw.config, vRaw.bosses, bossStage, null);
  assert.equal(bossInfo.modeId, 'mode_single_5');
  assert.ok(bossInfo.bosses.some(b => b.bossId === 'boss_11' && b.name === '假想敌：械'));
  assert.ok(bossInfo.bosses.some(b => b.bossId === 'boss_17' && b.name === '矩兽'));

  const vTerrain = sceneTerrain(vSim, bossStage, 'boss');
  const vCtx = { sim: vSim, config: vRaw.config, bosses: vRaw.bosses, terrain: vTerrain };
  let scene = emptyScene(bossStage, 'boss', { bossModeId: bossInfo.modeId });
  scene = editScene(scene, { type: 'add', kind: 'chess', id: yunjiNormal.id }, vCtx).scene;
  const deployTile = legalTilesFor(scene, { uid: 1 }, vCtx)[0];
  scene = editScene(scene, { type: 'deploy', uid: 1, row: deployTile[0], col: deployTile[1], dir: 'RIGHT' }, vCtx).scene;
  scene = editScene(scene, { type: 'selectBoss', bossId: 'boss_11' }, vCtx).scene;

  const bspec = sceneSpec(vSim, scene, vTerrain.goal, { config: vRaw.config, bosses: vRaw.bosses });
  assert.equal(bspec.version, 'act3autochess@V3_1');
  assert.equal(bspec.bossId, 'boss_11');
  const battle = spec.createBattleFromSpec(bspec, vSim.ds, { quiet: true });
  for (let i = 0; i < 30; i++) battle.step();
  assert.deepEqual(battle.errors, []);
  assert.ok(battle.allyUnits.some(u => u.def?.charId === 'char_4165_ctrail'));

  // Switch to the right half: keeps deployed operators mirrored, uses right-half escorts and the official right branch route.
  scene = editScene(scene, { type: 'selectBoss', bossId: 'boss_2' }, vCtx).scene;
  const leftSpec = sceneSpec(vSim, scene, vTerrain.goal, { config: vRaw.config, bosses: vRaw.bosses });
  const leftRoute = buildBossRoutePreview({ ...leftSpec, side: 'L' }, vSim.ds);
  assert.deepEqual(leftRoute.marks.map(m => m.at), [[5, 9], [2, 3], [3, 9]]);

  scene = editScene(scene, { type: 'setBossSide', side: 'R' }, vCtx).scene;
  assert.equal(scene.bossSide, 'R');
  assert.equal(scene.board.length, 1, 'switching halves preserves deployed operators');
  const rightTerrain = sceneTerrain(vSim, bossStage, 'boss', 'R');
  assert.equal(rightTerrain.deployField, 'bossR');
  const rightSpec = sceneSpec(vSim, scene, rightTerrain.goal, { config: vRaw.config, bosses: vRaw.bosses });
  assert.equal(rightSpec.players[0].side, 'R');
  assert.ok(rightSpec.spawns.filter(s => s.tag !== 'boss' && s.tag !== 'part').every(s => rightSpec.routes[s.routeIndex].end[1] > 10),
    'right-half mode spawns only right-half escorts');
  const rightRoute = buildBossRoutePreview({ ...rightSpec, side: 'R' }, vSim.ds);
  assert.deepEqual(rightRoute.marks.map(m => m.at), [[3, 11], [2, 17], [5, 11]],
    '规程 铳 right half uses its asymmetric right-branch patrol');
  const rightBattle = spec.createBattleFromSpec(rightSpec, vSim.ds, { quiet: true });
  rightBattle.start();
  const deployedAlly = rightBattle.allyUnits.find(u => u.def?.charId === 'char_4165_ctrail');
  assert.equal(deployedAlly.x, 20 - deployTile[1], 'right half mirrors operator column');
  assert.equal(deployedAlly.dir, 'LEFT', 'right half mirrors operator facing');
  for (let i = 0; i < 60; i++) rightBattle.step();
  assert.deepEqual(rightBattle.errors, []);
  const rightBoss = rightBattle.enemies.find(e => e.defId === 'enemy_9017_achunt');
  assert.ok(rightBoss && rightBoss.x > 10, 'right-half Boss actually moves onto the right half in combat');
});

test('operator catalogue search matches bond names (standard, DIY, localized, and multi-term) without matching raw bond IDs', () => {
  const ops = sceneOperators(raw);
  const termsFor = (op, opts) => [op.rec.name, op.id, op.charId, ...operatorBondNames(raw, op.rec, opts)];

  // Standard operator: 隐现 has 拉特兰 (lateranoShip) + 迅捷 (swiftShip).
  const insider = ops.find(op => op.id === 'chess_char_1_01_a');
  assert.ok(insider);
  assert.deepEqual(operatorBondNames(raw, insider.rec), ['拉特兰', '迅捷']);
  assert.equal(matchesCatalogueQuery(termsFor(insider), '拉特兰'), true);
  assert.equal(matchesCatalogueQuery(termsFor(insider), '迅捷'), true);
  assert.equal(matchesCatalogueQuery(termsFor(insider), '拉特兰 迅捷'), true);
  assert.equal(matchesCatalogueQuery(termsFor(insider), '迅捷 隐现'), true);
  assert.equal(matchesCatalogueQuery(termsFor(insider), '精准'), false);
  // Raw bond IDs (*Ship) must not pollute searches like "ship" or "sh".
  assert.equal(matchesCatalogueQuery(termsFor(insider), 'ship'), false);

  // DIY operators: 赤刃明霄陈 has 炎 (yanShip), prototype 郁金香 has 协防干员 (emptyShip).
  const chen = ops.find(op => op.charId === 'char_1050_chen3' && !op.golden);
  const tulip = ops.find(op => op.charId === 'char_608_acpion' && !op.golden);
  assert.ok(chen && tulip);
  assert.equal(matchesCatalogueQuery(termsFor(chen), '炎'), true);
  assert.equal(matchesCatalogueQuery(termsFor(chen), '炎 陈'), true);
  assert.equal(matchesCatalogueQuery(termsFor(tulip), '协防'), true);
  assert.equal(matchesCatalogueQuery(termsFor(tulip), '炎'), false);

  // Localized bond names work alongside original Chinese names.
  const enBonds = { lateranoShip: { name: 'Laterano' }, swiftShip: { name: 'Swift' } };
  const localizedTerms = termsFor(insider, { getBond: id => enBonds[id] || null });
  assert.equal(matchesCatalogueQuery(localizedTerms, 'laterano'), true);
  assert.equal(matchesCatalogueQuery(localizedTerms, 'SWIFT'), true);
  assert.equal(matchesCatalogueQuery(localizedTerms, '拉特兰'), true);

  // Versioned data (规程·序列Ⅰ) resolves its own bonds such as 乌萨斯 (ursusShip) and 聚合 (docShip).
  const dir = 'data/versions/act3autochess-v3_1';
  const loadJson = name => JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
  const vRaw = Object.fromEntries(['chess', 'bonds', 'backups', 'config'].map(n => [n, loadJson(n)]));
  const vOps = sceneOperators(vRaw);
  const ursusOp = vOps.find(op => op.rec.bonds?.includes('ursusShip'));
  const docOp = vOps.find(op => op.rec.bonds?.includes('docShip'));
  assert.ok(ursusOp && docOp);
  assert.equal(matchesCatalogueQuery([ursusOp.rec.name, ursusOp.id, ursusOp.charId, ...operatorBondNames(vRaw, ursusOp.rec)], '乌萨斯'), true);
  assert.equal(matchesCatalogueQuery([docOp.rec.name, docOp.id, docOp.charId, ...operatorBondNames(vRaw, docOp.rec)], '聚合'), true);
});

test('per-piece operator loadout (skill, module, potential, cultivate, skin) edits, simulates independently, and resets', () => {
  const ops = sceneOperators(raw);
  // Find a standard elite operator with >=2 skills and >=2 module options (including MODULE_NONE).
  const eliteOp = ops.find(op => {
    if (op.isDiy || !op.golden) return false;
    const base = raw.chess[op.rec.baseId || op.id];
    const opt = loadoutOptions(base, op.rec);
    return opt.skills.length >= 2 && opt.modules.length >= 2;
  });
  assert.ok(eliteOp, 'found a standard elite operator with multiple skills and modules');
  const normalId = eliteOp.rec.baseId;
  const opt = loadoutOptions(raw.chess[normalId], eliteOp.rec);
  const altSkill = opt.skills.find(s => s !== opt.defaultSkill);
  const altMod = opt.modules.find(m => m !== opt.defaultModule);
  assert.ok(altSkill != null && altMod != null);

  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: eliteOp.id }); // uid 1 (customized)
  scene = edit(scene, { type: 'add', kind: 'chess', id: eliteOp.id }); // uid 2 (default)
  scene = edit(scene, { type: 'add', kind: 'chess', id: normalId }); // uid 3 (normal)

  // Normal form cannot set module; invalid skill/potential/cultivate are rejected atomically.
  assert.deepEqual(editScene(scene, { type: 'configure', uid: 3, moduleId: altMod }, context), { error: '无效的调配选项' });
  assert.deepEqual(editScene(scene, { type: 'configure', uid: 1, skillIndex: 9 }, context), { error: '无效的调配选项' });
  assert.deepEqual(editScene(scene, { type: 'configure', uid: 1, potential: 9 }, context), { error: '无效的调配选项' });
  assert.deepEqual(editScene(scene, { type: 'configure', uid: 1, cultivate: 9 }, context), { error: '无效的调配选项' });

  // Customize uid 1 while keeping uid 2 at defaults.
  scene = edit(scene, {
    type: 'configure', uid: 1, skillIndex: altSkill, moduleId: altMod, potential: 1, cultivate: 0, skin: 'test_skin#1',
  });
  const p1 = scene.hand.find(p => p?.uid === 1);
  const p2 = scene.hand.find(p => p?.uid === 2);
  const st1 = pieceConfigState(raw, p1);
  const st2 = pieceConfigState(raw, p2);
  assert.equal(st1.changed, true);
  assert.equal(st1.skillIndex, altSkill);
  assert.equal(st1.moduleId, altMod);
  assert.equal(st1.potential, 1);
  assert.equal(st1.cultivate, 0);
  assert.equal(st1.skin, 'test_skin#1');
  assert.deepEqual(pieceLoadoutMap(raw, p1), { [normalId]: { skill: altSkill, module: altMod } });
  assert.deepEqual(pieceOpsMap(raw, p1), { [eliteOp.charId]: { potential: 1, cultivate: 0 } });
  assert.equal(st2.changed, false);
  assert.equal(pieceLoadoutMap(raw, p2), null);
  assert.equal(pieceOpsMap(raw, p2), null);

  // Deploy both copies and verify each fights with its own loadout, cultivation, and skin in the same battle.
  const tiles = legalTilesFor(scene, { uid: 1 }, context);
  scene = edit(scene, { type: 'deploy', uid: 1, row: tiles[0][0], col: tiles[0][1], dir: 'RIGHT' });
  scene = edit(scene, { type: 'deploy', uid: 2, row: tiles[1][0], col: tiles[1][1], dir: 'RIGHT' });
  const bspec = sceneSpec(sim, scene, context.terrain.goal, { config: raw.config, bosses: raw.bosses });
  const battle = spec.createBattleFromSpec(bspec, sim.ds, { quiet: true });
  battle.step();
  assert.deepEqual(battle.errors, []);
  const u1 = battle.allyUnits.find(u => u.uid === 1);
  const u2 = battle.allyUnits.find(u => u.uid === 2);
  assert.equal(u1.def.loadout.skillIndex, altSkill);
  assert.equal(u1.def.loadout.moduleId, altMod);
  assert.equal(u1.def.loadout.potential, 1);
  assert.equal(u1.cultivate, 0);
  assert.equal(u1.skin, 'test_skin#1');
  assert.equal(u2.def.loadout.skillIndex, opt.defaultSkill);
  assert.equal(u2.def.loadout.moduleId, opt.defaultModule);
  assert.equal(u2.def.loadout.potential, 6);
  assert.equal(u2.cultivate, 3);
  assert.equal(u2.skin, null);
  assert.ok(u1._s.atk < u2._s.atk, 'cultivate 0 has lower ATK than default cultivate 3');
  const metaUnits = battle.fieldMeta().units;
  assert.equal(metaUnits.find(u => u.uid === 1)?.skin, 'test_skin#1');
  assert.equal(metaUnits.find(u => u.uid === 2)?.skin, undefined);

  // Reset restores all fields on uid 1 back to defaults.
  scene = edit(scene, { type: 'configure', uid: 1, reset: true });
  assert.equal(pieceConfigState(raw, scene.board.find(p => p.uid === 1)).changed, false);

  // DIY owned operator (赤刃明霄陈 elite) supports skill, MODULE_NONE, potential, cultivate, skin, and reset.
  const chenElite = ops.find(op => op.charId === 'char_1050_chen3' && op.golden);
  const tulipElite = ops.find(op => op.charId === 'char_608_acpion' && op.golden);
  assert.ok(chenElite && tulipElite);
  let diyScene = emptyScene();
  diyScene = edit(diyScene, { type: 'add', kind: 'chess', id: chenElite.id, diy: chenElite.diy }); // uid 1
  diyScene = edit(diyScene, { type: 'add', kind: 'chess', id: tulipElite.id, diy: tulipElite.diy }); // uid 2
  const altChenSkill = chenElite.diy.skillIndex === 0 ? 1 : 0;
  diyScene = edit(diyScene, {
    type: 'configure', uid: 1, skillIndex: altChenSkill, moduleId: MODULE_NONE, potential: 2, cultivate: 1, skin: 'chen3_skin#1',
  });
  const chenPiece = diyScene.hand.find(p => p?.uid === 1);
  assert.equal(chenPiece.diy.skillIndex, altChenSkill);
  assert.equal(chenPiece.diy.uniEquipId, null);
  assert.equal(pieceConfigState(raw, chenPiece).changed, true);

  const diyTile = legalTilesFor(diyScene, { uid: 1 }, context)[0];
  diyScene = edit(diyScene, { type: 'deploy', uid: 1, row: diyTile[0], col: diyTile[1], dir: 'RIGHT' });
  const diyBattle = spec.createBattleFromSpec(sceneSpec(sim, diyScene, context.terrain.goal, { config: raw.config, bosses: raw.bosses }), sim.ds, { quiet: true });
  diyBattle.step();
  assert.deepEqual(diyBattle.errors, []);
  const diyUnit = diyBattle.allyUnits.find(u => u.uid === 1);
  assert.equal(diyUnit.def.skill.index, altChenSkill);
  assert.equal(diyUnit.def.loadout.potential, 2);
  assert.equal(diyUnit.cultivate, 1);
  assert.equal(diyUnit.skin, 'chen3_skin#1');

  diyScene = edit(diyScene, { type: 'configure', uid: 1, reset: true });
  assert.equal(pieceConfigState(raw, diyScene.board.find(p => p.uid === 1)).changed, false);

  // DIY prototype locks skill/module/potential/cultivate, while allowing skin changes.
  assert.deepEqual(editScene(diyScene, { type: 'configure', uid: 2, skillIndex: 0 }, context), { error: '无效的调配选项' });
  assert.deepEqual(editScene(diyScene, { type: 'configure', uid: 2, potential: 1 }, context), { error: '无效的调配选项' });
  diyScene = edit(diyScene, { type: 'configure', uid: 2, skin: 'proto_skin#1' });
  assert.equal(diyScene.hand.find(p => p?.uid === 2).skin, 'proto_skin#1');
});

test('placeable summons (Mon3tr, DIY 凯尔希, 凯尔希·思衡托, 杰西卡, 赫默) mirror formal prep lifecycle and combat', () => {
  // 1) 规程·序列Ⅰ Mon3tr (chess_char_5_20_b) grants 重构体 (ownerRange + MELEE), enforces range, lifts on rotate/move, fights in battle.
  const dir = 'data/versions/act3autochess-v3_1';
  const loadJson = name => JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
  const vRaw = Object.fromEntries(
    ['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups', 'config', 'bosses']
      .map(n => [n, loadJson(n)]),
  );
  const vSim = { raw: vRaw, ds: new DataSource(vRaw, null), spec };
  const vStage = defaultStageOf(vRaw.stages);
  const vCtx = { sim: vSim, config: vRaw.config, bosses: vRaw.bosses, terrain: sceneTerrain(vSim, vStage) };
  const editV = (s, action) => {
    const res = editScene(s, action, vCtx);
    assert.ok(res.scene, res.error);
    return res.scene;
  };

  let vScene = emptyScene(vStage);
  vScene = editV(vScene, { type: 'add', kind: 'chess', id: 'chess_char_5_20_b' }); // Mon3tr elite, uid 1
  const monTiles = legalTilesFor(vScene, { uid: 1 }, vCtx);
  const monTile = monTiles.find(([r, c]) => monTiles.some(([r2, c2]) => r2 === r && c2 === c + 2)) || monTiles[0];
  vScene = editV(vScene, { type: 'deploy', uid: 1, row: monTile[0], col: monTile[1], dir: 'RIGHT' });
  const prosts = vScene.hand.find(p => p?.kind === 'token' && p.id === 'token_10050_monstr_prosts');
  assert.ok(prosts && prosts.ownerUid === 1, 'deploying Mon3tr grants 重构体 to bench');

  const prostsTiles = legalTilesFor(vScene, { uid: prosts.uid }, vCtx);
  assert.ok(prostsTiles.length > 0, '重构体 has legal tiles inside Mon3tr attack range');
  // A ground tile outside Mon3tr's rightward range must be refused.
  const outTile = monTiles.find(([r, c]) => !prostsTiles.some(([tr, tc]) => tr === r && tc === c) && (r !== monTile[0] || c !== monTile[1]));
  if (outTile) {
    assert.deepEqual(
      editScene(vScene, { type: 'deploy', uid: prosts.uid, row: outTile[0], col: outTile[1], dir: 'RIGHT' }, vCtx),
      { error: '只能部署在召唤者攻击范围内' },
    );
  }
  const frontProstsTile = prostsTiles.find(([, c]) => c === monTile[1] + 2) || prostsTiles[0];
  vScene = editV(vScene, { type: 'deploy', uid: prosts.uid, row: frontProstsTile[0], col: frontProstsTile[1], dir: 'RIGHT' });
  assert.ok(vScene.board.some(p => p.kind === 'token' && p.id === 'token_10050_monstr_prosts'), '重构体 deployed onto board');

  // Entering combat spawns both Mon3tr and 重构体 with ownerUnit linked.
  const monSpec = sceneSpec(vSim, vScene, vCtx.terrain.goal, { config: vRaw.config, bosses: vRaw.bosses });
  assert.ok(monSpec.players[0].units.some(u => u.kind === 'token' && u.tokenId === 'token_10050_monstr_prosts' && u.ownerUid === 1));
  const monBattle = spec.createBattleFromSpec(monSpec, vSim.ds, { quiet: true });
  for (let i = 0; i < 20; i++) monBattle.step();
  assert.deepEqual(monBattle.errors, []);
  const monUnit = monBattle.allyUnits.find(u => u.uid === 1);
  const prostsUnit = monBattle.allyUnits.find(u => u.kind === 'token' && u.defId === 'token_10050_monstr_prosts');
  assert.ok(monUnit && prostsUnit && prostsUnit.ownerUnit === monUnit, '重构体 deploys in battle linked to Mon3tr');

  // Re-orienting Mon3tr away lifts out-of-range 重构体 back to bench; retreating Mon3tr removes it completely.
  vScene = editV(vScene, { type: 'face', uid: 1, dir: 'LEFT' });
  assert.equal(vScene.board.some(p => p.kind === 'token'), false, 're-orienting Mon3tr lifts out-of-range 重构体');
  assert.ok(vScene.hand.some(p => p?.kind === 'token' && p.ownerUid === 1));
  vScene = editV(vScene, { type: 'retreat', uid: 1 });
  assert.equal(vScene.hand.some(p => p?.kind === 'token' && p.ownerUid === 1), false, 'retreating Mon3tr removes its summons');

  // 2) 规程·序列Ⅰ 杰西卡 (chess_char_4_14_b) grants 机动盾牌 restricted to the 4 adjacent tiles.
  let jessScene = emptyScene(vStage);
  jessScene = editV(jessScene, { type: 'add', kind: 'chess', id: 'chess_char_4_14_b' });
  const jessTile = legalTilesFor(jessScene, { uid: 1 }, vCtx)[0];
  jessScene = editV(jessScene, { type: 'deploy', uid: 1, row: jessTile[0], col: jessTile[1], dir: 'RIGHT' });
  const shield = jessScene.hand.find(p => p?.kind === 'token' && p.id === 'token_10032_jesca2_jckshd');
  assert.ok(shield, 'deploying 杰西卡 grants 机动盾牌');
  const shieldTiles = legalTilesFor(jessScene, { uid: shield.uid }, vCtx);
  assert.ok(shieldTiles.every(([r, c]) => Math.abs(r - jessTile[0]) + Math.abs(c - jessTile[1]) === 1), '机动盾牌 only legal on 4 adjacent tiles');
  const farGround = legalTilesFor(jessScene, { uid: 1 }, vCtx).find(([r, c]) => Math.abs(r - jessTile[0]) + Math.abs(c - jessTile[1]) >= 2);
  if (farGround) {
    assert.deepEqual(
      editScene(jessScene, { type: 'deploy', uid: shield.uid, row: farGround[0], col: farGround[1], dir: 'RIGHT' }, vCtx),
      { error: '只能部署在召唤者相邻四格' },
    );
  }

  // 3) DIY 凯尔希 (char_003_kalts) grants Mon3tr (token_10002_kalts_mon3tr), inherits skin, deploys & fights, and retreats cleanly even when bench is 10/10.
  const ops = sceneOperators(raw);
  const kalts = ops.find(op => op.charId === 'char_003_kalts' && op.golden);
  assert.ok(kalts, 'DIY 凯尔希 elite exists');
  let kScene = emptyScene();
  kScene = edit(kScene, { type: 'add', kind: 'chess', id: kalts.id, diy: kalts.diy }); // uid 1
  kScene = edit(kScene, { type: 'configure', uid: 1, skin: 'char_003_kalts@boc#6' });
  const kTile = legalTilesFor(kScene, { uid: 1 }, context)[0];
  kScene = edit(kScene, { type: 'deploy', uid: 1, row: kTile[0], col: kTile[1], dir: 'RIGHT' });
  const mon3trTok = kScene.hand.find(p => p?.kind === 'token' && p.id === 'token_10002_kalts_mon3tr');
  assert.ok(mon3trTok && mon3trTok.ownerUid === 1, 'deploying DIY 凯尔希 grants Mon3tr to bench');
  assert.equal(mon3trTok.skin, 'char_003_kalts@boc#6', 'Mon3tr inherits 凯尔希 skin');
  const mon3trTile = legalTilesFor(kScene, { uid: mon3trTok.uid }, context)[0];
  kScene = edit(kScene, { type: 'deploy', uid: mon3trTok.uid, row: mon3trTile[0], col: mon3trTile[1], dir: 'RIGHT' });
  const kBattle = spec.createBattleFromSpec(sceneSpec(sim, kScene, context.terrain.goal, { config: raw.config, bosses: raw.bosses }), sim.ds, { quiet: true });
  for (let i = 0; i < 20; i++) kBattle.step();
  assert.deepEqual(kBattle.errors, []);
  const kMon3trUnit = kBattle.allyUnits.find(u => u.kind === 'token' && u.defId === 'token_10002_kalts_mon3tr');
  assert.ok(kMon3trUnit && kMon3trUnit.skin === 'char_003_kalts@boc#6', 'DIY Mon3tr deploys in battle with owner skin');
  // Tokens cannot be destroyed directly, but retreating owner removes them (even when bench is full).
  assert.ok(editScene(kScene, { type: 'remove', uid: mon3trTok.uid }, context).error);
  kScene = edit(kScene, { type: 'retreat', uid: mon3trTok.uid });
  while (kScene.hand.includes(null)) kScene = edit(kScene, { type: 'add', kind: 'chess', id: chess });
  assert.equal(kScene.hand.filter(Boolean).length, GEO.HAND_SIZE);
  kScene = edit(kScene, { type: 'retreat', uid: 1 });
  assert.equal(kScene.board.length, 0, 'retreating owner succeeds at 10/10 bench by freeing its own summon stack slot');

  // 4) DIY 凯尔希·思衡托 (char_1052_kalts2) grants 战术锚点 (ownerRangeOutside + rangedTilesOnly).
  const kalts2 = ops.find(op => op.charId === 'char_1052_kalts2' && op.golden);
  if (kalts2) {
    const m03 = 'act1autochess_m03';
    const m03Ctx = { sim, config: raw.config, terrain: sceneTerrain(sim, m03) };
    const [hr, hc] = raw.stages[m03].deployTiles.normal.rangedOnly[0];
    let k2Scene = emptyScene(m03);
    k2Scene = editScene(k2Scene, { type: 'add', kind: 'chess', id: kalts2.id, diy: kalts2.diy }, m03Ctx).scene;
    k2Scene = editScene(k2Scene, { type: 'deploy', uid: 1, row: hr, col: hc, dir: 'RIGHT' }, m03Ctx).scene;
    const anchor = k2Scene.hand.find(p => p?.kind === 'token' && p.ownerUid === 1);
    assert.ok(anchor, 'deploying 凯尔希·思衡托 grants 战术锚点');
    const anchorTiles = legalTilesFor(k2Scene, { uid: anchor.uid }, m03Ctx);
    const lowTile = raw.stages[m03].deployTiles.normal.melee.find(([r, c]) => !m03Ctx.terrain.reserved.has(m03Ctx.terrain.grid.key(r, c)));
    assert.deepEqual(
      editScene(k2Scene, { type: 'deploy', uid: anchor.uid, row: lowTile[0], col: lowTile[1], dir: 'RIGHT' }, m03Ctx),
      { error: '只能部署在远程位' },
    );
    assert.ok(anchorTiles.every(([r, c]) => raw.stages[m03].deployTiles.normal.rangedOnly.some(([rr, rc]) => rr === r && rc === c)));
  }

  // 5) Skill-dependent summon reconciliation: 赫默 (chess_char_2_02_a) S2 grants 医疗探机, S1 removes it.
  const silenceId = Object.keys(raw.chess).find(id => !raw.chess[id]?.isGolden && raw.chess[id]?.tokens?.includes('token_10000_silent_healrb'));
  assert.ok(silenceId, '赫默 exists in default chess');
  let sScene = emptyScene();
  sScene = edit(sScene, { type: 'add', kind: 'chess', id: silenceId }); // uid 1
  const sTile = legalTilesFor(sScene, { uid: 1 }, context)[0];
  sScene = edit(sScene, { type: 'deploy', uid: 1, row: sTile[0], col: sTile[1], dir: 'RIGHT' });
  assert.ok(placeableTokensOf(raw, sScene.board[0]).some(x => x.tokenId === 'token_10000_silent_healrb'));
  assert.ok(sScene.hand.some(p => p?.kind === 'token' && p.id === 'token_10000_silent_healrb'), '赫默 S2 grants 医疗探机');
  sScene = edit(sScene, { type: 'configure', uid: 1, skillIndex: 0 });
  assert.equal(sScene.hand.some(p => p?.kind === 'token' && p.id === 'token_10000_silent_healrb'), false, 'switching 赫默 to S1 removes 医疗探机');
  sScene = edit(sScene, { type: 'configure', uid: 1, skillIndex: 1, skin: 'silent_skin#1' });
  const drone = sScene.hand.find(p => p?.kind === 'token' && p.id === 'token_10000_silent_healrb');
  assert.ok(drone && drone.skin === 'silent_skin#1', 'switching 赫默 back to S2 re-grants 医疗探机 with updated skin');

  // 6) 规程·序列Ⅰ switch-hand garrison populates playerInput.bench and units follow boardOrder.
  const switchChessId = Object.keys(vRaw.chess).find(id => !vRaw.chess[id]?.isGolden && (vRaw.chess[id]?.garrisonIds || []).some(gid =>
    ['act3autochess_gar_effect_switchcharinhand[trigger]', 'act3autochess_gar_effect_switchhand_triggergar'].includes(vRaw.garrisons[gid]?.effectKey)));
  assert.ok(switchChessId, 'found a 规程·序列Ⅰ bench-switch operator');
  let swScene = emptyScene(vStage);
  swScene = editV(swScene, { type: 'add', kind: 'chess', id: switchChessId }); // uid 1
  swScene = editV(swScene, { type: 'add', kind: 'chess', id: 'chess_char_1_01_a' }); // uid 2 (on bench)
  swScene = editV(swScene, { type: 'add', kind: 'chess', id: 'chess_char_1_02_a' }); // uid 3 (deployed lower row)
  const swTiles = legalTilesFor(swScene, { uid: 1 }, vCtx);
  const lowRowTile = swTiles.reduce((a, b) => (b[0] < a[0] ? b : a));
  const highRowTile = swTiles.reduce((a, b) => (b[0] > a[0] ? b : a));
  swScene = editV(swScene, { type: 'deploy', uid: 3, row: lowRowTile[0], col: lowRowTile[1], dir: 'RIGHT' });
  swScene = editV(swScene, { type: 'deploy', uid: 1, row: highRowTile[0], col: highRowTile[1], dir: 'RIGHT' });
  const swSpec = sceneSpec(vSim, swScene, vCtx.terrain.goal, { config: vRaw.config, bosses: vRaw.bosses });
  assert.equal(swSpec.players[0].units[0].uid, 1, 'boardOrder puts higher board row first');
  assert.ok(Array.isArray(swSpec.players[0].bench) && swSpec.players[0].bench.some(b => b.uid === 2), 'switch-hand operator receives playerInput.bench');
});

test('applySavedLoadout projects unified browser loadout/diy/ops/skins onto Test Scene pieces and reconciles summons', () => {
  const silenceId = Object.keys(raw.chess).find(id => !raw.chess[id]?.isGolden && raw.chess[id]?.tokens?.includes('token_10000_silent_healrb'));
  assert.ok(silenceId, '赫默 exists');
  const silenceChar = raw.chess[silenceId].charId;
  const ops = sceneOperators(raw);
  const kalts = ops.find(op => op.charId === 'char_003_kalts' && op.golden);
  assert.ok(kalts, 'DIY 凯尔希 (精锐) exists');

  let scene = emptyScene();
  scene = edit(scene, { type: 'add', kind: 'chess', id: silenceId }); // uid 1
  scene = edit(scene, { type: 'add', kind: 'chess', id: kalts.id, diy: kalts.diy }); // uid 2
  const sTile = legalTilesFor(scene, { uid: 1 }, context)[0];
  scene = edit(scene, { type: 'deploy', uid: 1, row: sTile[0], col: sTile[1], dir: 'RIGHT' });
  assert.ok(scene.hand.some(p => p?.kind === 'token' && p.ownerUid === 1), '赫默 starts with 医疗探机');

  // Saved loadout switches 赫默 to S1 (removes drone) + sets potential/cultivate/skin, and sets DIY 凯尔希 via diy slot.
  const slotBase = raw.chess[kalts.id].baseId || kalts.id;
  const saved1 = {
    entries: { [silenceId]: { skill: 0 } },
    byChar: {},
    ops: { [silenceChar]: { potential: 2, cultivate: 1 }, [kalts.charId]: { potential: 3, cultivate: 2 } },
    diy: { [slotBase]: { charId: kalts.charId, skillIndex: 1, uniEquipId: null } },
    skins: { [silenceChar]: 'silent_skin#1', [kalts.charId]: 'kalts_skin#1' },
  };
  scene = applySavedLoadout(raw, scene, saved1);
  const sBoard = scene.board.find(p => p.uid === 1);
  const kHand = scene.hand.find(p => p?.uid === 2);
  assert.equal(sBoard.skillIndex, 0);
  assert.equal(sBoard.potential, 2);
  assert.equal(sBoard.cultivate, 1);
  assert.equal(sBoard.skin, 'silent_skin#1');
  assert.equal(scene.hand.some(p => p?.kind === 'token' && p.ownerUid === 1), false, 'saved S1 removes 医疗探机');
  assert.equal(kHand.diy.skillIndex, 1);
  assert.equal(kHand.diy.uniEquipId, null);
  assert.equal(kHand.potential, 3);
  assert.equal(kHand.cultivate, 2);
  assert.equal(kHand.skin, 'kalts_skin#1');
  assert.equal(applySavedLoadout(raw, scene, saved1), scene, 'idempotent when saved loadout has not changed');

  // Switching 赫默 back to default S2 re-grants 医疗探机 with her skin, and unslotted DIY reads byChar fallback.
  const saved2 = {
    entries: {},
    byChar: { [kalts.charId]: { skill: 0, module: MODULE_NONE } },
    ops: {},
    diy: {},
    skins: { [silenceChar]: 'silent_skin#2' },
  };
  scene = applySavedLoadout(raw, scene, saved2);
  const drone = scene.hand.find(p => p?.kind === 'token' && p.ownerUid === 1);
  assert.ok(drone && drone.skin === 'silent_skin#2', 'restoring S2 re-grants 医疗探机 with updated skin');
  const kHand2 = scene.hand.find(p => p?.uid === 2);
  assert.equal(kHand2.diy.skillIndex, 0, 'unslotted DIY operator reads saved byChar skill');
  assert.equal(kHand2.diy.uniEquipId, null, 'unslotted DIY operator reads saved byChar MODULE_NONE');
  assert.equal(kHand2.skin, undefined);
});
