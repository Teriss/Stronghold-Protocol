import { GEO } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { checkDiyPick, diyPool, diyRecord, diySlot, diySlotIds, isDiyModule, isPrototypePick } from '../../../shared/diy.js';
import { chessIsDiy, equipmentCapacity, itemForbidsDiy } from '../../../shared/itemRules.js';
import { unitForm } from '../../../shared/standIn.js';
import { placementContext, tileAllows } from '../ui/gameLogic/placement.js';

export const DEFAULT_STAGE = 'act1autochess_m01';
export const BATTLE_CAP = 240;
const PLAYER_ID = 'test-scene';
const DIRS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

export function sceneStages(stages) {
  return Object.values(stages).filter(stage => stage.active && (stage.kind == null || stage.kind === 'normal'));
}

export function sceneEquipment(item) {
  return item.itemType === 'EQUIP' && !item.kind?.startsWith('consume_on_equip');
}

/** Resolve the effective chess record for a Test Scene piece (composing DIY picks from backups.json). */
export function chessRecordOf(raw, piece) {
  if (!raw?.chess || !piece) return null;
  const base = raw.chess[piece.id] || null;
  if (!base) return null;
  if (base.isDiy && piece.diy) return diyRecord(piece.id, piece.diy, { data: raw });
  return base;
}

function defaultDiyPick(raw, slotId, charId) {
  const slot = diySlot(slotId, raw);
  if (!slot || !slot.normal || !slot.golden || !raw?.backups) return null;
  if (isPrototypePick(raw, slot.tier, charId)) {
    const checked = checkDiyPick(slotId, { charId }, raw);
    return 'ok' in checked ? checked.pick : null;
  }
  const normal = unitForm(raw.backups, charId, slot.normal.status);
  const elite = unitForm(raw.backups, charId, slot.golden.status);
  if (!normal || !elite) return null;
  const skills = (normal.skills || []).filter(Boolean);
  const skillIndex = skills.length ? skills[skills.length - 1].index : 0;
  const mod = (elite.modules || []).find(isDiyModule) || null;
  const checked = checkDiyPick(slotId, { charId, skillIndex, uniEquipId: mod ? mod.uniEquipId : null }, raw);
  return 'ok' in checked ? checked.pick : null;
}

/** All playable operators in the default 盟约 data: standard chess records plus every 自选 (DIY) operator (normal & elite). */
export function sceneOperators(raw) {
  const out = [];
  if (!raw?.chess) return out;
  for (const [id, rec] of Object.entries(raw.chess)) {
    if (!rec || rec.isDiy) continue;
    out.push({ key: id, id, diy: null, rec, charId: rec.charId || null, golden: !!rec.isGolden, isDiy: false });
  }
  if (!raw.backups) return out;
  const slots = diySlotIds(raw).map(id => diySlot(id, raw)).filter(Boolean);
  const slotByTier = new Map();
  for (const s of slots) if (!slotByTier.has(s.tier)) slotByTier.set(s.tier, s);
  const pool6 = diyPool(6, { data: raw });
  const pool5 = diyPool(5, { data: raw });
  const seen = new Set();
  for (const [tier, pool] of [[6, pool6], [5, pool5]]) {
    const slot = slotByTier.get(tier);
    if (!slot) continue;
    for (const charId of pool) {
      if (seen.has(charId)) continue;
      seen.add(charId);
      const pick = defaultDiyPick(raw, slot.baseId, charId);
      if (!pick) continue;
      const recA = diyRecord(slot.baseId, pick, { elite: false, data: raw });
      const recB = diyRecord(slot.goldenId, pick, { elite: true, data: raw });
      if (recA) out.push({ key: `${slot.baseId}:${charId}`, id: slot.baseId, diy: pick, rec: recA, charId, golden: false, isDiy: true });
      if (recB) out.push({ key: `${slot.goldenId}:${charId}`, id: slot.goldenId, diy: pick, rec: recB, charId, golden: true, isDiy: true });
    }
  }
  return out;
}

export function emptyScene(stageId = DEFAULT_STAGE) {
  return { stageId, hand: Array(GEO.HAND_SIZE).fill(null), board: [], enemies: [], nextUid: 1 };
}

export function hasCombatants(scene) {
  return scene.board.length > 0 || scene.enemies.length > 0;
}

export function sceneSpec(sim, scene, goal) {
  return sim.spec.buildBattleSpec({
    battleId: PLAYER_ID, fieldId: PLAYER_ID, seed: 1, round: 1, kind: 'normal', modeId: 'mode_single_normal',
    stageId: scene.stageId, rect: GEO.NORMAL_RECT, timeLimit: BATTLE_CAP,
    players: [{ playerId: PLAYER_ID, side: 'L', seat: 0, units: scene.board.map(p => ({
      uid: p.uid, kind: p.kind, chessId: p.id, row: p.row, col: p.col, dir: p.dir, items: p.items.map(item => item.id),
      ...(p.diy ? { diy: p.diy } : null),
    })) }],
    spawns: scene.enemies.map(({ id, row, col, motion }) => ({
      time: 0, enemyKey: id, pos: [row, col], route: { motion, start: [row, col], end: goal },
      sourcePlayerId: PLAYER_ID, countInTotal: true,
    })),
  });
}

/** Read the time-zero terrain from the same simulation that will execute the scene. */
export function sceneTerrain(sim, stageId) {
  const probe = sim.spec.createBattleFromSpec(sceneSpec(sim, emptyScene(stageId)), sim.ds, { quiet: true });
  probe.start();
  const { grid } = probe;
  const goal = grid.specialTiles('end')[0];
  const reserved = new Set(probe.units.filter(u => u.alive && u.deployed && grid.inRect(u.y, u.x))
    .map(u => grid.key(u.y, u.x)));
  return { grid, goal, reserved };
}

const at = (list, row, col) => list.find(p => p.row === row && p.col === col);
const replace = (list, uid, piece) => list.map(p => p?.uid === uid ? piece : p);

function findPiece(scene, uid) {
  return scene.board.find(p => p.uid === uid) || scene.hand.find(p => p?.uid === uid);
}

function updatePiece(scene, piece) {
  return { ...scene, hand: replace(scene.hand, piece.uid, piece), board: replace(scene.board, piece.uid, piece) };
}

function removePiece(scene, uid) {
  return { ...scene, hand: replace(scene.hand, uid, null), board: scene.board.filter(p => p.uid !== uid) };
}

function putInHand(scene, piece, preferredIdx = null) {
  const idx = Number.isInteger(preferredIdx) && preferredIdx >= 0 && preferredIdx < GEO.HAND_SIZE && scene.hand[preferredIdx] == null
    ? preferredIdx
    : scene.hand.indexOf(null);
  if (idx < 0) return { error: t('整备区已满') };
  const hand = scene.hand.slice();
  hand[idx] = piece;
  return { scene: { ...scene, hand } };
}

function enemyTileAllowed(enemy, row, col, scene, terrain) {
  const { grid, goal, reserved } = terrain;
  if (!enemy || !goal || !grid.inRect(row, col) || (row === goal[0] && col === goal[1])) return 'bad_tile';
  if (reserved.has(grid.key(row, col)) || at(scene.enemies, row, col) || at(scene.board, row, col)) return 'occupied';
  const fly = enemy.motion === 'FLY';
  if (fly ? !grid.flyPassable(row, col) : (!grid.groundPassable(row, col) || !grid.findPath(row, col, ...goal))) {
    return 'no_route';
  }
  return null;
}

/** Build the `setPrep` state for the live field renderer (operators, items, and placed enemy previews). */
export function prepViewState(scene, nameOf = ({ id }) => id) {
  return {
    hand: scene.hand,
    board: scene.board,
    prepMapChars: scene.enemies.map(e => ({
      uid: e.uid,
      kind: 'enemy',
      side: 'enemy',
      defId: e.id,
      name: nameOf(e),
      x: e.col,
      y: e.row,
      dir: 'LEFT',
      facing: -1,
      motion: e.motion,
      spine: e.id,
      avatar: e.id,
    })),
  };
}

function tileAllowsPiece(baseCtx, raw, piece, row, col) {
  if (!piece?.diy) return tileAllows(baseCtx, piece, row, col);
  return tileAllows({ ...baseCtx, getChess: id => (id === piece.id ? chessRecordOf(raw, piece) : raw.chess[id]) }, piece, row, col);
}

function canEquipPiece(raw, itemPiece, target, config) {
  if (itemPiece?.kind !== 'item' || target?.kind !== 'chess') return { ok: false, error: t('装备只能配发给干员') };
  const targetRec = chessRecordOf(raw, target);
  if (itemForbidsDiy(raw.items[itemPiece.id]) && chessIsDiy(targetRec)) return { ok: false, error: t('无法装备给自选干员') };
  const capacity = equipmentCapacity(targetRec, config.economy?.equipPerChess);
  if (target.items.length >= capacity) return { ok: false, error: t('该干员的装备栏已满') };
  return { ok: true };
}

/** Whether dropping `uid` onto `target` in the live field renderer is legal. */
export function canPlaceInScene(scene, uid, target, { sim, terrain, config }) {
  const piece = findPiece(scene, uid);
  if (!piece || !target) return false;
  const stage = sim.raw.stages[scene.stageId];
  if (target.area === 'hand') {
    const idx = target.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) return false;
    const occ = scene.hand[idx];
    if (piece.kind === 'item') {
      if (occ?.kind === 'chess') return canEquipPiece(sim.raw, piece, occ, config).ok;
      return true;
    }
    if (piece.row != null) {
      if (!occ) return true;
      if (occ.kind === 'chess') {
        const ctx = placementContext({ priv: scene, stage, editable: true, getChess: id => sim.raw.chess[id] });
        return tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col);
      }
      return scene.hand.includes(null);
    }
    return true;
  }
  if (target.area === 'board') {
    const { row, col } = target;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
    const occ = at(scene.board, row, col);
    if (piece.kind === 'item') return !!occ && canEquipPiece(sim.raw, piece, occ, config).ok;
    if (piece.kind !== 'chess') return false;
    if (piece.row === row && piece.col === col) return true;
    const ctx = placementContext({ priv: scene, stage, editable: true, getChess: id => sim.raw.chess[id] });
    if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) return false;
    const { grid, reserved } = terrain;
    if (reserved.has(grid.key(row, col)) || at(scene.enemies, row, col)) return false;
    if (occ) return piece.row != null && tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col);
    return true;
  }
  return false;
}

/** Board tiles `[[row, col], ...]` to highlight for the active selection, drag, or armed enemy. */
export function legalTilesFor(scene, focus, { sim, terrain, config }) {
  const tiles = [];
  if (!focus) return tiles;
  const stage = sim.raw.stages[scene.stageId];
  const { grid, reserved } = terrain;
  if (focus.enemy) {
    const enemy = sim.ds.getEnemy(focus.enemy);
    if (!enemy) return tiles;
    const R = GEO.NORMAL_RECT;
    for (let row = R.r0; row <= R.r1; row++) {
      for (let col = R.c0; col <= R.c1; col++) {
        if (!enemyTileAllowed(enemy, row, col, scene, terrain)) tiles.push([row, col]);
      }
    }
    return tiles;
  }
  const piece = findPiece(scene, focus.uid);
  if (!piece) return tiles;
  if (piece.kind === 'item') {
    for (const p of scene.board) {
      if (canEquipPiece(sim.raw, piece, p, config).ok) tiles.push([p.row, p.col]);
    }
    return tiles;
  }
  if (piece.kind === 'chess') {
    const ctx = placementContext({ priv: scene, stage, editable: true, getChess: id => sim.raw.chess[id] });
    const F = GEO.FIELD;
    for (let row = F.r0; row <= F.r1; row++) {
      for (let col = F.c0; col <= F.c1; col++) {
        if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) continue;
        if (reserved.has(grid.key(row, col)) || at(scene.enemies, row, col)) continue;
        const occ = at(scene.board, row, col);
        if (occ && occ.uid !== piece.uid && !(piece.row != null && tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col))) continue;
        tiles.push([row, col]);
      }
    }
  }
  return tiles;
}

/** Applies one editor action. Rejected actions leave the scene untouched. */
export function editScene(scene, action, { sim, terrain, config }) {
  const { uid, row, col } = action;
  const piece = findPiece(scene, uid);
  const { grid, reserved } = terrain;
  const stage = sim.raw.stages[scene.stageId];
  switch (action.type) {
    case 'add': {
      const p = { uid: scene.nextUid, kind: action.kind, id: action.id };
      if (p.kind === 'chess') {
        const rec = sim.raw.chess[p.id];
        if (!rec) return { error: t('找不到该单位') };
        if (rec.isDiy) {
          const checked = checkDiyPick(p.id, action.diy, sim.raw);
          if (!('ok' in checked) || !diyRecord(p.id, checked.pick, { data: sim.raw })) return { error: t('找不到该单位') };
          Object.assign(p, { dir: 'RIGHT', golden: !!rec.isGolden, diy: checked.pick, items: [] });
        } else {
          Object.assign(p, { dir: 'RIGHT', golden: !!rec.isGolden, items: [] });
        }
      } else if (p.kind !== 'item' || !sim.raw.items[p.id] || !sceneEquipment(sim.raw.items[p.id])) {
        return { error: t('无法放置在该位置') };
      }
      return putInHand({ ...scene, nextUid: p.uid + 1 }, p);
    }
    case 'deploy': {
      const ctx = placementContext({ priv: scene, stage, editable: true, getChess: id => sim.raw.chess[id] });
      const nextDir = DIRS.includes(action.dir) ? action.dir : piece?.dir;
      if (piece?.kind !== 'chess' || !tileAllowsPiece(ctx, sim.raw, piece, row, col)) return { error: t('无法部署在该位置') };
      if (piece.row === row && piece.col === col) {
        return { scene: nextDir && nextDir !== piece.dir ? updatePiece(scene, { ...piece, dir: nextDir }) : scene };
      }
      if (reserved.has(grid.key(row, col)) || at(scene.enemies, row, col)) return { error: t('该位置已有单位') };
      const occ = at(scene.board, row, col);
      if (occ) {
        if (piece.row == null || !tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col)) return { error: t('该位置已有单位') };
        return {
          scene: {
            ...scene,
            board: scene.board.map(p => p.uid === piece.uid ? { ...piece, row, col, dir: nextDir }
              : p.uid === occ.uid ? { ...occ, row: piece.row, col: piece.col } : p),
          },
        };
      }
      const next = removePiece(scene, uid);
      return { scene: { ...next, board: [...next.board, { ...piece, row, col, dir: nextDir }] } };
    }
    case 'moveHand': {
      const idx = action.idx;
      if (!piece || piece.row != null || !Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) {
        return { error: t('无法放置在该位置') };
      }
      const fromIdx = scene.hand.findIndex(p => p?.uid === uid);
      if (fromIdx < 0) return { error: t('找不到该单位') };
      if (fromIdx === idx) return { scene };
      const hand = scene.hand.slice();
      hand[fromIdx] = hand[idx];
      hand[idx] = piece;
      return { scene: { ...scene, hand } };
    }
    case 'equip': {
      const target = findPiece(scene, action.target);
      const check = canEquipPiece(sim.raw, piece, target, config);
      if (!check.ok) return { error: check.error };
      return { scene: updatePiece(removePiece(scene, uid), { ...target, items: [...target.items, piece] }) };
    }
    case 'unequip': {
      const item = piece?.items?.find(p => p.uid === action.itemUid);
      if (!item) break;
      return putInHand(updatePiece(scene, { ...piece, items: piece.items.filter(p => p !== item) }), item);
    }
    case 'retreat': {
      if (piece?.row == null) break;
      const idx = action.idx;
      const occ = Number.isInteger(idx) && idx >= 0 && idx < GEO.HAND_SIZE ? scene.hand[idx] : null;
      if (occ?.kind === 'chess') {
        const ctx = placementContext({ priv: scene, stage, editable: true, getChess: id => sim.raw.chess[id] });
        if (!tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col)) return { error: t('无法部署在该位置') };
        const { row: r, col: c, ...rest } = piece;
        const hand = scene.hand.slice();
        hand[idx] = rest;
        const board = scene.board.map(p => p.uid === piece.uid ? { ...occ, row: r, col: c } : p);
        return { scene: { ...scene, hand, board } };
      }
      const { row: _row, col: _col, ...rest } = piece;
      return putInHand(removePiece(scene, uid), rest, idx);
    }
    case 'face':
      if (piece?.row != null && DIRS.includes(action.dir)) {
        return { scene: updatePiece(scene, { ...piece, dir: action.dir }) };
      }
      break;
    case 'enemy': {
      const enemy = sim.ds.getEnemy(action.id);
      const err = enemyTileAllowed(enemy, row, col, scene, terrain);
      if (err === 'bad_tile') return { error: t('无法放置在该位置') };
      if (err === 'occupied') return { error: t('该位置已有单位') };
      if (err === 'no_route') return { error: t('敌人无法从该位置前往蓝门') };
      const p = { uid: scene.nextUid, kind: 'enemy', id: action.id, motion: enemy.motion, row, col };
      return { scene: { ...scene, nextUid: p.uid + 1, enemies: [...scene.enemies, p] } };
    }
    case 'remove':
      return { scene: { ...removePiece(scene, uid), enemies: scene.enemies.filter(p => p.uid !== uid) } };
  }
  return { error: t('找不到该单位') };
}
