import { GEO } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { equipmentCapacity } from '../../../shared/itemRules.js';
import { placementContext, tileAllows } from '../ui/gameLogic/placement.js';

export const DEFAULT_STAGE = 'act1autochess_m01';
export const BATTLE_CAP = 240;
const PLAYER_ID = 'test-scene';

export function sceneStages(stages) {
  return Object.values(stages).filter(stage => stage.active && (stage.kind == null || stage.kind === 'normal'));
}

export function sceneEquipment(item) {
  return item.itemType === 'EQUIP' && !item.kind?.startsWith('consume_on_equip');
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

function putInHand(scene, piece) {
  const idx = scene.hand.indexOf(null);
  if (idx < 0) return { error: t('整备区已满') };
  const hand = scene.hand.slice();
  hand[idx] = piece;
  return { scene: { ...scene, hand } };
}

/** Applies one editor action. Rejected actions leave the scene untouched. */
export function editScene(scene, action, { sim, terrain, config }) {
  const { uid, row, col } = action;
  const piece = findPiece(scene, uid);
  const { grid, goal, reserved } = terrain;
  const stage = sim.raw.stages[scene.stageId];
  const occupied = () => reserved.has(grid.key(row, col)) || at(scene.enemies, row, col) || at(scene.board, row, col);
  switch (action.type) {
    case 'add': {
      const p = { uid: scene.nextUid, kind: action.kind, id: action.id };
      if (p.kind === 'chess') {
        const rec = sim.raw.chess[p.id];
        if (!rec || rec.isDiy) return { error: t('找不到该单位') };
        Object.assign(p, { dir: 'RIGHT', items: [] });
      } else if (p.kind !== 'item' || !sim.raw.items[p.id] || !sceneEquipment(sim.raw.items[p.id])) {
        return { error: t('无法放置在该位置') };
      }
      return putInHand({ ...scene, nextUid: p.uid + 1 }, p);
    }
    case 'deploy': {
      const ctx = placementContext({ priv: scene, stage, editable: true, getChess: id => sim.raw.chess[id] });
      if (piece?.kind !== 'chess' || !tileAllows(ctx, piece, row, col)) return { error: t('无法部署在该位置') };
      if (piece.row === row && piece.col === col) return { scene };
      if (occupied()) return { error: t('该位置已有单位') };
      const next = removePiece(scene, uid);
      return { scene: { ...next, board: [...next.board, { ...piece, row, col }] } };
    }
    case 'equip': {
      const target = findPiece(scene, action.target);
      if (piece?.kind !== 'item' || target?.kind !== 'chess') return { error: t('装备只能配发给干员') };
      const capacity = equipmentCapacity(sim.raw.chess[target.id], config.economy?.equipPerChess);
      if (target.items.length >= capacity) return { error: t('该干员的装备栏已满') };
      return { scene: updatePiece(removePiece(scene, uid), { ...target, items: [...target.items, piece] }) };
    }
    case 'unequip': {
      const item = piece?.items?.find(p => p.uid === action.itemUid);
      if (!item) break;
      return putInHand(updatePiece(scene, { ...piece, items: piece.items.filter(p => p !== item) }), item);
    }
    case 'retreat': {
      if (piece?.row == null) break;
      const { row: _row, col: _col, ...rest } = piece;
      return putInHand(removePiece(scene, uid), rest);
    }
    case 'face':
      if (piece?.row != null && ['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(action.dir)) {
        return { scene: updatePiece(scene, { ...piece, dir: action.dir }) };
      }
      break;
    case 'enemy': {
      const enemy = sim.ds.getEnemy(action.id);
      if (!enemy || !goal || !grid.inRect(row, col) || (row === goal[0] && col === goal[1])) {
        return { error: t('无法放置在该位置') };
      }
      if (occupied()) return { error: t('该位置已有单位') };
      const fly = enemy.motion === 'FLY';
      if (fly ? !grid.flyPassable(row, col) : (!grid.groundPassable(row, col) || !grid.findPath(row, col, ...goal))) {
        return { error: t('敌人无法从该位置前往蓝门') };
      }
      const p = { uid: scene.nextUid, kind: 'enemy', id: action.id, motion: enemy.motion, row, col };
      return { scene: { ...scene, nextUid: p.uid + 1, enemies: [...scene.enemies, p] } };
    }
    case 'remove':
      return { scene: { ...removePiece(scene, uid), enemies: scene.enemies.filter(p => p.uid !== uid) } };
  }
  return { error: t('找不到该单位') };
}
