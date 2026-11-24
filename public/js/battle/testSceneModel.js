import { BOND_LAYER_CAP, GEO } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { checkDiyPick, diyPool, diyRecord, diySlot, diySlotIds, isDiyModule, isPrototypePick } from '../../../shared/diy.js';
import { chessIsDiy, equipmentCapacity, itemForbidsDiy } from '../../../shared/itemRules.js';
import { grantedBondsByMorph } from '../../../shared/plugins/rules.js';
import { CULTIVATE_DEFAULT, POTENTIAL_DEFAULT } from '../../../shared/potential.js';
import { unitForm } from '../../../shared/standIn.js';
import { DEFAULT_VERSION, versionOfData } from '../../../shared/versions.js';
import { fieldTile } from '../ui/gameLogic/camera.js';
import { piecePosition, placementContext, tileAllows } from '../ui/gameLogic/placement.js';

export const DEFAULT_STAGE = 'act1autochess_m01';
export const DEFAULT_MODE = 'mode_single_normal';
export const BATTLE_CAP = 240;
const PLAYER_ID = 'test-scene';
const DIRS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const HARMONY_BOND = 'maniShip';
const DEPUTY_BOND = 'deputShip';
const ACLOON = 'enemy_9012_acloon';
const DIFFICULTY_ORDER = { FAST: 0, FUNNY: 1, NORMAL: 2, HARD: 3, ABYSS: 4 };

export function sceneStages(stages) {
  return Object.values(stages || {}).filter(stage => stage && stage.active && (stage.kind == null || stage.kind === 'normal'));
}

export function defaultStageOf(stages) {
  const list = Array.isArray(stages) ? stages : sceneStages(stages);
  return list.find(s => s.id === DEFAULT_STAGE)?.id || list[0]?.id || DEFAULT_STAGE;
}

export function defaultModeOf(config) {
  const modes = config?.modes && typeof config.modes === 'object' ? config.modes : {};
  if (modes[DEFAULT_MODE]) return DEFAULT_MODE;
  const singles = Object.entries(modes)
    .filter(([id, m]) => m && m.type === 'SINGLE' && !id.startsWith('mode_training'))
    .sort(([a, x], [b, y]) => (DIFFICULTY_ORDER[x.difficulty] ?? 9) - (DIFFICULTY_ORDER[y.difficulty] ?? 9)
      || (x.sortId ?? 0) - (y.sortId ?? 0) || a.localeCompare(b));
  const fullBonds = singles.find(([, m]) => !Array.isArray(m.inactiveBondIds) || m.inactiveBondIds.length === 0);
  return fullBonds?.[0] || singles[0]?.[0] || DEFAULT_MODE;
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

export function emptyScene(stageId = DEFAULT_STAGE, fieldMode = 'normal', { bossModeId = null, bossId = null } = {}) {
  const boss = fieldMode === 'boss';
  return {
    stageId,
    fieldMode: boss ? 'boss' : 'normal',
    bossModeId: boss ? bossModeId : null,
    bossId: boss ? bossId : null,
    bondLayers: {},
    hand: Array(GEO.HAND_SIZE).fill(null),
    temp: Array(GEO.TEMP_SIZE).fill(null),
    board: [],
    enemies: [],
    nextUid: 1,
  };
}

export function deployFieldOfScene(scene) {
  return scene?.fieldMode === 'boss' ? 'bossL' : 'normal';
}

export function stageCoordOf(scene, row, col) {
  return fieldTile(deployFieldOfScene(scene), row, col);
}

export function hasCombatants(scene) {
  if (!scene) return false;
  if (scene.board.length > 0) return true;
  return scene.fieldMode === 'boss' ? Boolean(scene.bossId) : scene.enemies.length > 0;
}

/** Clamp a bond layer edit to the official 0..BOND_LAYER_CAP (999) range. */
export function clampBondLayers(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return BOND_LAYER_CAP > 0 ? Math.min(BOND_LAYER_CAP, n) : n;
}

function bondThresholds(bond) {
  return Array.isArray(bond?.thresholds) && bond.thresholds.length ? bond.thresholds : [];
}

function bondTierFor(bond, count) {
  if (!bond || !(count > 0)) return 0;
  if (bond.thresholdTemplate === 'count_threshold_downward' || bond.maxCount != null) {
    const max = Number.isInteger(bond.maxCount) ? bond.maxCount : bondThresholds(bond)[0] ?? 1;
    return count >= 1 && count <= max ? 1 : 0;
  }
  let tier = 0;
  for (const th of bondThresholds(bond)) if (count >= th) tier++;
  return tier;
}

function pieceBondIds(raw, piece) {
  const rec = chessRecordOf(raw, piece);
  const out = rec && Array.isArray(rec.bonds) ? rec.bonds.slice() : [];
  const items = Array.isArray(piece?.items) ? piece.items : [];
  for (const b of grantedBondsByMorph(items, id => raw?.items?.[id], { bondOk: id => !!raw?.bonds?.[id] })) {
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

function memberBaseKey(raw, piece) {
  const baseRec = raw?.chess?.[piece.id];
  const baseId = baseRec?.baseId || piece.id;
  if (baseRec?.isDiy && piece?.diy?.charId) return `${baseId}:${piece.diy.charId}`;
  return baseId;
}

/**
 * Compute official bond activation states for a Test Scene (mirrors server/match/bondsMeta.js computeBonds).
 * Includes BOARD / BOARD_AND_DECK / BOARD_ALL_CHESS (绝技), 调和 (+1 to core bonds), 助力 (variant upper tiers),
 * 独行 (downward threshold), 变形同构体 granted bonds, and DIY operators.
 */
export function sceneBondStates(raw, scene) {
  const out = {};
  if (!raw?.bonds || !scene) return out;
  const boardChess = (scene.board || []).filter(p => p && p.kind === 'chess');
  const handChess = (scene.hand || []).filter(p => p && p.kind === 'chess');
  const onBoard = new Map();
  const onBoardVariant = new Map();
  const inHand = new Map();
  const add = (m, bond, key) => { let s = m.get(bond); if (!s) m.set(bond, (s = new Set())); s.add(key); };
  let goldenOnBoard = 0;
  for (const p of boardChess) {
    const key = memberBaseKey(raw, p);
    const golden = Boolean(p.golden || raw.chess?.[p.id]?.isGolden);
    if (golden) goldenOnBoard++;
    for (const b of pieceBondIds(raw, p)) {
      add(onBoard, b, key);
      add(onBoardVariant, b, `${key}|${golden ? 1 : 0}`);
    }
  }
  for (const p of handChess) {
    const key = memberBaseKey(raw, p);
    for (const b of pieceBondIds(raw, p)) add(inHand, b, key);
  }
  const rawCounts = {};
  for (const [id, bond] of Object.entries(raw.bonds)) {
    if (!bond) continue;
    if (bond.countMode === 'BOARD_ALL_CHESS' || bond.thresholdTemplate === 'count_threshold_upward_golden') {
      rawCounts[id] = goldenOnBoard;
    } else if (bond.countMode === 'BOARD_AND_DECK') {
      rawCounts[id] = new Set([...(onBoard.get(id) || []), ...(inHand.get(id) || [])]).size;
    } else {
      rawCounts[id] = (onBoard.get(id) || new Set()).size;
    }
  }
  const harmonyBond = raw.bonds[HARMONY_BOND];
  const harmonyActive = Boolean(harmonyBond && bondTierFor(harmonyBond, rawCounts[HARMONY_BOND] || 0) >= 1);
  for (const [id, bond] of Object.entries(raw.bonds)) {
    if (!bond) continue;
    const harmonyBonus = harmonyActive && bond.isCore && (onBoard.get(id)?.size ?? 0) >= 1 ? 1 : 0;
    const count = (rawCounts[id] || 0) + harmonyBonus;
    let tier = bondTierFor(bond, count);
    if (id === DEPUTY_BOND && tier >= 1) {
      const variants = onBoardVariant.get(id)?.size ?? 0;
      const th = bondThresholds(bond);
      let nextTier = 1;
      for (let i = 1; i < th.length; i++) if (variants >= th[i]) nextTier = i + 1;
      tier = nextTier;
    }
    const layers = bond.noStack ? 0 : clampBondLayers(scene.bondLayers?.[id]);
    out[id] = { count, active: tier >= 1, tier, layers, ...(harmonyBonus ? { harmony: harmonyBonus } : null) };
  }
  return out;
}

/** Bond list in the exact shape consumed by BondStrip / BondPopup / DetailPanel (`m.private.bonds`). */
export function sceneBondList(raw, scene) {
  const states = sceneBondStates(raw, scene);
  const out = [];
  for (const [bondId, st] of Object.entries(states)) {
    const bond = raw.bonds?.[bondId];
    if (!bond) continue;
    if (!st.active && !(st.count > 0) && !(st.layers > 0)) continue;
    out.push({
      bondId,
      count: st.count,
      active: st.active,
      tier: st.tier,
      layers: st.layers,
      ...(st.harmony ? { harmony: st.harmony } : null),
      thresholds: bondThresholds(bond),
      countsHand: bond.countMode === 'BOARD_AND_DECK',
    });
  }
  return out;
}

/** BattleSpec `players[].bonds` snapshot (mirrors server/match/bondsMeta.js bondSnapshot). */
export function sceneBondSnapshot(raw, scene) {
  const states = sceneBondStates(raw, scene);
  const snap = {};
  for (const [id, st] of Object.entries(states)) {
    snap[id] = { count: st.count, active: !!st.active, tier: st.tier, layers: st.layers };
  }
  return snap;
}

function dpFlagsOf(config) {
  const d = config?.dp && typeof config.dp === 'object' ? config.dp : {};
  const num = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return { dpInit: num(d.init, 10), dpPerSec: num(d.perSec, 1), dpMax: num(d.max, 99) };
}

function enemyScaleOf(config, modeId, round) {
  const e = config?.modes?.[modeId]?.enemyScale?.[String(round)];
  if (!e || typeof e !== 'object') return { hpMul: 1, atkMul: 1, speedMul: 1 };
  const num = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const supply = num(e.supplyHp, 1);
  return {
    hpMul: Math.max(0.01, num(e.hp, 1)),
    atkMul: Math.max(0, num(e.atk, 1)),
    speedMul: Math.max(0.01, num(e.speed, 1)),
    ...(supply > 0 && supply !== 1 ? { supplyHpMul: supply } : null),
  };
}

function bossPoolHpFor(config, bossRec, modeId) {
  const mode = config?.modes?.[modeId];
  const diff = mode?.difficulty || 'NORMAL';
  let base = Number.isFinite(bossRec?.bloodByMode?.[modeId]) ? bossRec.bloodByMode[modeId] : null;
  if (base == null && bossRec?.bloodPoint && Number.isFinite(bossRec.bloodPoint[diff])) base = bossRec.bloodPoint[diff];
  if (base == null && bossRec?.bloodPoint) base = Object.values(bossRec.bloodPoint).find(v => Number.isFinite(v)) ?? null;
  if (base == null) base = 500000;
  const ms = mode?.bossHpScale || {};
  const cs = config?.bossHpScale || {};
  const soloShare = Number.isFinite(ms.solo) && ms.solo > 0 ? ms.solo
    : Number.isFinite(cs.solo) && cs.solo > 0 ? cs.solo : 1;
  return Math.max(1, Math.round(base * soloShare));
}

function enemySlotClass(raw, enemyKey) {
  const e = raw?.enemies?.[enemyKey];
  const fly = typeof e?.isFlyEnemy === 'boolean' ? e.isFlyEnemy : e?.stats?.motion === 'FLY';
  const elite = Boolean(e?.rank && e.rank !== 'NORMAL');
  if (fly) return elite ? 'EF' : 'NF';
  return elite ? 'E' : 'N';
}

/** Single-player difficulties available for a stage in official data (excludes tutorial). */
export function stageBossModes(raw, config, stageId) {
  const stage = raw?.stages?.[stageId];
  const modesMap = config?.modes || {};
  const ids = Array.isArray(stage?.modes) ? stage.modes : [];
  const out = [];
  for (const modeId of ids) {
    if (modeId.startsWith('mode_training')) continue;
    const m = modesMap[modeId];
    if (!m || m.type !== 'SINGLE') continue;
    out.push({
      modeId,
      difficulty: m.difficulty || 'NORMAL',
      sortId: m.sortId ?? 0,
      name: m.name || modeId,
      bossWeights: m.bossWeights || {},
      hiddenBossWeights: m.hiddenBossWeights || {},
    });
  }
  out.sort((a, b) => (DIFFICULTY_ORDER[a.difficulty] ?? 9) - (DIFFICULTY_ORDER[b.difficulty] ?? 9)
    || (a.sortId - b.sortId) || a.modeId.localeCompare(b.modeId));
  return out;
}

/** Official selectable bosses for a stage and difficulty, with their real wave templates and HP pools. */
export function stageBosses(raw, config, bosses, stageId, preferredModeId = null) {
  const modes = stageBossModes(raw, config, stageId);
  const fallbackModeId = defaultModeOf(config);
  const mode = modes.find(m => m.modeId === preferredModeId)
    || modes.find(m => m.modeId === fallbackModeId)
    || modes.find(m => Object.keys(m.hiddenBossWeights || {}).length > 0)
    || modes[0]
    || null;
  if (!mode || !bosses) return { modeId: null, difficulty: null, modes, bosses: [] };
  const modeId = mode.modeId;
  const list = [];
  const pushWeights = (weights, hidden) => {
    for (const [bossId, w] of Object.entries(weights || {})) {
      if (!(Number(w) > 0)) continue;
      const rec = bosses[bossId];
      if (!rec) continue;
      const tplInfo = rec.templates?.[modeId]
        || rec.templates?.[fallbackModeId]
        || Object.entries(rec.templates || {}).find(([k]) => k.startsWith('mode_single_'))?.[1]
        || Object.values(rec.templates || {})[0];
      const templateId = tplInfo?.template || null;
      const tpl = templateId ? raw?.waves?.[templateId] : null;
      if (!tpl) continue;
      const round = Number.isInteger(tplInfo?.round) ? tplInfo.round : (hidden ? 15 : 14);
      const escorts = [];
      const counts = new Map();
      for (const s of tpl.spawns || []) {
        if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
        const key = s.key ?? s.enemyKey;
        if (!key || key === ACLOON || s.tag === 'boss') continue;
        const n = Math.max(1, Math.min(50, Number.isInteger(s.count) ? s.count : 1));
        const bucket = s.tag === 'part' ? `part:${key}` : `escort:${key}`;
        const prev = counts.get(bucket);
        if (prev) prev.count += n;
        else {
          const entry = { key, count: n, isPart: s.tag === 'part' };
          counts.set(bucket, entry);
          escorts.push(entry);
        }
      }
      list.push({
        bossId,
        enemyKey: rec.enemyKey,
        name: rec.name || bossId,
        hidden: Boolean(hidden || rec.hidden),
        sortId: rec.sortId ?? 99,
        round,
        templateId,
        poolHp: bossPoolHpFor(config, rec, modeId),
        escorts,
      });
    }
  };
  pushWeights(mode.bossWeights, false);
  pushWeights(mode.hiddenBossWeights, true);
  list.sort((a, b) => (Number(a.hidden) - Number(b.hidden)) || (a.sortId - b.sortId));
  return { modeId, difficulty: mode.difficulty, modes, bosses: list };
}

/** Build the exact official Boss wave spawns, routes, overrides, scale, and HP pool for a selected boss. */
export function bossWaveConfig(raw, config, bosses, scene) {
  if (!scene || scene.fieldMode !== 'boss' || !scene.bossId || !bosses) return null;
  const info = stageBosses(raw, config, bosses, scene.stageId, scene.bossModeId);
  const picked = info.bosses.find(b => b.bossId === scene.bossId);
  if (!picked) return null;
  const tpl = raw?.waves?.[picked.templateId];
  if (!tpl) return null;
  const scale = enemyScaleOf(config, info.modeId, picked.round);
  const spawns = [];
  const list = Array.isArray(tpl.spawns) ? tpl.spawns : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
    const key = s.key ?? s.enemyKey;
    if (typeof key !== 'string' || key === ACLOON || !raw?.enemies?.[key]) continue;
    const tag = s.tag ?? null;
    const isBoss = tag === 'boss';
    const isPart = tag === 'part';
    const count = Math.max(1, Math.min(50, Number.isInteger(s.count) ? s.count : 1));
    const interval = Math.max(0, Number(s.interval) || 0);
    const time = Math.max(0, Number(s.time) || 0);
    const routeIndex = Number.isInteger(s.routeIndex) ? s.routeIndex : 0;
    const slot = s.slot || enemySlotClass(raw, key);
    const mods = isBoss
      ? { atkMul: scale.atkMul, speedMul: scale.speedMul, slot }
      : { hpMul: scale.hpMul, atkMul: scale.atkMul, speedMul: scale.speedMul, ...(scale.supplyHpMul != null ? { supplyHpMul: scale.supplyHpMul } : null), slot };
    const spec = {
      time,
      enemyKey: key,
      routeIndex,
      count,
      interval: count > 1 ? interval : 0,
      mods,
      actionIndex: i,
    };
    if (tag) spec.tag = tag;
    if (s.unharmful || isPart) spec.countInTotal = false;
    spawns.push(spec);
  }
  return {
    ...picked,
    modeId: info.modeId,
    difficulty: info.difficulty,
    scale,
    spawns,
    routes: Array.isArray(tpl.routes) ? tpl.routes : [],
    overrides: tpl.overrides && typeof tpl.overrides === 'object' ? tpl.overrides : {},
  };
}

function unitSpecOf(raw, p) {
  const rec = raw?.chess?.[p.id];
  const isProto = Boolean(rec?.isDiy && p.diy && isPrototypePick(raw, rec.tier, p.diy.charId));
  return {
    uid: p.uid,
    kind: p.kind,
    chessId: p.id,
    row: p.row,
    col: p.col,
    dir: p.dir,
    items: p.items.map(item => item.id),
    ...(p.diy ? { diy: p.diy } : null),
    ...(!isProto ? { potential: POTENTIAL_DEFAULT, cultivate: CULTIVATE_DEFAULT } : null),
  };
}

export function sceneSpec(sim, scene, goal, { config = null, bosses = null } = {}) {
  const cfg = config || sim.raw?.config || null;
  const bossTable = bosses || sim.raw?.bosses || null;
  const boss = scene.fieldMode === 'boss';
  const dp = dpFlagsOf(cfg);
  const versionId = versionOfData({ config: cfg || sim.raw?.config });
  const versionOpt = versionId !== DEFAULT_VERSION ? { version: versionId } : null;
  const fallbackMode = defaultModeOf(cfg);
  const playerInput = {
    playerId: PLAYER_ID,
    side: 'L',
    seat: 0,
    bonds: sceneBondSnapshot(sim.raw, scene),
    units: scene.board.map(p => unitSpecOf(sim.raw, p)),
  };
  if (boss) {
    const wave = bossWaveConfig(sim.raw, cfg, bossTable, scene);
    if (wave) {
      return sim.spec.buildBattleSpec({
        ...versionOpt,
        battleId: PLAYER_ID,
        fieldId: PLAYER_ID,
        seed: 1,
        round: wave.round,
        kind: wave.hidden ? 'hidden' : 'boss',
        modeId: wave.modeId,
        stageId: scene.stageId,
        rect: GEO.BOSS_RECT,
        timeLimit: Infinity,
        players: [playerInput],
        spawns: wave.spawns,
        routes: wave.routes,
        enemyOverrides: wave.overrides,
        waveId: wave.templateId,
        bossId: wave.bossId,
        boss: { poolHp: wave.poolHp, poolMax: wave.poolHp },
        flags: { layerGainsEnabled: false, ...dp, enemyScale: wave.scale },
      });
    }
    return sim.spec.buildBattleSpec({
      ...versionOpt,
      battleId: PLAYER_ID,
      fieldId: PLAYER_ID,
      seed: 1,
      round: 14,
      kind: 'boss',
      modeId: scene.bossModeId || fallbackMode,
      stageId: scene.stageId,
      rect: GEO.BOSS_RECT,
      timeLimit: Infinity,
      players: [playerInput],
      spawns: [],
      routes: [],
      flags: { layerGainsEnabled: false, ...dp },
    });
  }
  return sim.spec.buildBattleSpec({
    ...versionOpt,
    battleId: PLAYER_ID,
    fieldId: PLAYER_ID,
    seed: 1,
    round: 1,
    kind: 'normal',
    modeId: fallbackMode,
    stageId: scene.stageId,
    rect: GEO.NORMAL_RECT,
    timeLimit: BATTLE_CAP,
    players: [playerInput],
    flags: { layerGainsEnabled: true, ...dp },
    spawns: scene.enemies.map(({ id, row, col, motion }) => {
      const pos = stageCoordOf(scene, row, col);
      return {
        time: 0, enemyKey: id, pos, route: { motion, start: pos, end: goal },
        sourcePlayerId: PLAYER_ID, countInTotal: true,
      };
    }),
  });
}

/** Read the time-zero terrain from the same simulation that will execute the scene. */
export function sceneTerrain(sim, stageId, fieldMode = 'normal') {
  const mode = fieldMode === 'boss' ? 'boss' : 'normal';
  const probe = sim.spec.createBattleFromSpec(sceneSpec(sim, emptyScene(stageId, mode)), sim.ds, { quiet: true });
  probe.start();
  const { grid } = probe;
  const ends = grid.specialTiles('end');
  const goal = (mode === 'boss' ? ends.find(([, c]) => c <= 10) : null) || ends[0];
  const reserved = new Set(probe.units.filter(u => u.alive && u.deployed && grid.inRect(u.y, u.x))
    .map(u => grid.key(u.y, u.x)));
  return { grid, goal, reserved, fieldMode: mode, deployField: mode === 'boss' ? 'bossL' : 'normal' };
}

const at = (list, row, col) => list.find(p => p.row === row && p.col === col);
const replace = (list, uid, piece) => list.map(p => p?.uid === uid ? piece : p);

function findPiece(scene, uid) {
  return scene.board.find(p => p.uid === uid)
    || scene.hand.find(p => p?.uid === uid)
    || scene.temp?.find(p => p?.uid === uid);
}

function updatePiece(scene, piece) {
  return {
    ...scene,
    hand: replace(scene.hand, piece.uid, piece),
    temp: replace(scene.temp || [], piece.uid, piece),
    board: replace(scene.board, piece.uid, piece),
  };
}

function removePiece(scene, uid) {
  return {
    ...scene,
    hand: replace(scene.hand, uid, null),
    temp: replace(scene.temp || [], uid, null),
    board: scene.board.filter(p => p.uid !== uid),
  };
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

function putInTemp(scene, piece, preferredIdx = null) {
  const cur = Array.isArray(scene.temp) ? scene.temp : Array(GEO.TEMP_SIZE).fill(null);
  const idx = Number.isInteger(preferredIdx) && preferredIdx >= 0 && preferredIdx < GEO.TEMP_SIZE && cur[preferredIdx] == null
    ? preferredIdx
    : cur.indexOf(null);
  if (idx < 0) return { error: t('装备区已满') };
  const temp = cur.slice();
  temp[idx] = piece;
  return { scene: { ...scene, temp } };
}

function enemyTileAllowed(enemy, row, col, scene, terrain) {
  if (scene.fieldMode === 'boss') return 'boss_locked';
  const { grid, goal, reserved } = terrain;
  const [sr, sc] = stageCoordOf(scene, row, col);
  if (!enemy || !goal || !grid.inRect(sr, sc) || (sr === goal[0] && sc === goal[1])) return 'bad_tile';
  if (reserved.has(grid.key(sr, sc)) || at(scene.enemies, row, col) || at(scene.board, row, col)) return 'occupied';
  const fly = enemy.motion === 'FLY';
  if (fly ? !grid.flyPassable(sr, sc) : (!grid.groundPassable(sr, sc) || !grid.findPath(sr, sc, ...goal))) {
    return 'no_route';
  }
  return null;
}

/** Build the `setPrep` state for the live field renderer (operators, equipment area, bonds, and placed enemy previews). */
export function prepViewState(scene, nameOf = ({ id }) => id, raw = null) {
  return {
    playerId: PLAYER_ID,
    equipHand: true,
    hand: scene.hand,
    temp: scene.temp || Array(GEO.TEMP_SIZE).fill(null),
    board: scene.board,
    bonds: raw ? sceneBondList(raw, scene) : [],
    prepMapChars: scene.fieldMode === 'boss' ? [] : scene.enemies.map(e => ({
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

function scenePlacementCtx(scene, stage, raw) {
  return placementContext({
    priv: scene, stage, editable: true, field: deployFieldOfScene(scene),
    getChess: id => raw.chess[id],
  });
}

function tileAllowsPiece(baseCtx, raw, piece, row, col) {
  if (!piece?.diy) return tileAllows(baseCtx, piece, row, col);
  return tileAllows({ ...baseCtx, getChess: id => (id === piece.id ? chessRecordOf(raw, piece) : raw.chess[id]) }, piece, row, col);
}

function deployRefuseReason(baseCtx, raw, piece, row, col) {
  const ctx = piece?.diy
    ? { ...baseCtx, getChess: id => (id === piece.id ? chessRecordOf(raw, piece) : raw.chess[id]) }
    : baseCtx;
  const deployable = ctx.deploy.ranged.has(`${row},${col}`);
  const pos = piecePosition(ctx, piece);
  if (deployable && pos === 'MELEE') return t('近战单位只能部署在地面');
  if (deployable && pos === 'HIGH') return t('只能部署在远程位');
  return t('无法部署在该位置');
}

function canEquipPiece(raw, itemPiece, target, config, { allowReplace = false } = {}) {
  if (itemPiece?.kind !== 'item' || target?.kind !== 'chess') return { ok: false, error: t('装备只能配发给干员') };
  const targetRec = chessRecordOf(raw, target);
  if (itemForbidsDiy(raw.items[itemPiece.id]) && chessIsDiy(targetRec)) return { ok: false, error: t('无法装备给自选干员') };
  const capacity = equipmentCapacity(targetRec, config.economy?.equipPerChess);
  if (!allowReplace && target.items.length >= capacity) return { ok: false, error: t('该干员的装备栏已满') };
  return { ok: true, needsReplace: target.items.length >= capacity };
}

/** Whether dropping `itemUid` on `targetUid` needs the replace-equipment dialog (full slots, legal equip). */
export function equipNeedsReplace(scene, itemUid, targetUid, { sim, config }) {
  const itemPiece = findPiece(scene, itemUid);
  const target = findPiece(scene, targetUid);
  const check = canEquipPiece(sim.raw, itemPiece, target, config, { allowReplace: true });
  return check.ok && check.needsReplace === true;
}

/** Whether dropping `uid` onto `target` in the live field renderer is legal. */
export function canPlaceInScene(scene, uid, target, { sim, terrain, config }) {
  const piece = findPiece(scene, uid);
  if (!piece || !target) return false;
  const stage = sim.raw.stages[scene.stageId];
  if (target.area === 'temp') {
    const idx = target.idx;
    return piece.kind === 'item' && Number.isInteger(idx) && idx >= 0 && idx < GEO.TEMP_SIZE;
  }
  if (target.area === 'hand') {
    const idx = target.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) return false;
    const occ = scene.hand[idx];
    if (piece.kind === 'item') {
      return occ?.kind === 'chess' && canEquipPiece(sim.raw, piece, occ, config, { allowReplace: true }).ok;
    }
    if (piece.row != null) {
      if (!occ) return true;
      if (occ.kind === 'chess') {
        const ctx = scenePlacementCtx(scene, stage, sim.raw);
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
    if (piece.kind === 'item') return !!occ && canEquipPiece(sim.raw, piece, occ, config, { allowReplace: true }).ok;
    if (piece.kind !== 'chess') return false;
    if (piece.row === row && piece.col === col) return true;
    const ctx = scenePlacementCtx(scene, stage, sim.raw);
    if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) return false;
    const { grid, reserved } = terrain;
    const [sr, sc] = stageCoordOf(scene, row, col);
    if (reserved.has(grid.key(sr, sc)) || at(scene.enemies, row, col)) return false;
    if (occ) return piece.row == null || tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col);
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
    if (scene.fieldMode === 'boss') return tiles;
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
      if (canEquipPiece(sim.raw, piece, p, config, { allowReplace: true }).ok) tiles.push([p.row, p.col]);
    }
    return tiles;
  }
  if (piece.kind === 'chess') {
    const ctx = scenePlacementCtx(scene, stage, sim.raw);
    const F = GEO.FIELD;
    for (let row = F.r0; row <= F.r1; row++) {
      for (let col = F.c0; col <= F.c1; col++) {
        if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) continue;
        const [sr, sc] = stageCoordOf(scene, row, col);
        if (reserved.has(grid.key(sr, sc)) || at(scene.enemies, row, col)) continue;
        const occ = at(scene.board, row, col);
        if (occ && occ.uid !== piece.uid && piece.row != null && !tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col)) continue;
        tiles.push([row, col]);
      }
    }
  }
  return tiles;
}

/** Applies one editor action. Rejected actions leave the scene untouched. */
export function editScene(scene, action, { sim, terrain, config, bosses = null }) {
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
        return putInHand({ ...scene, nextUid: p.uid + 1 }, p);
      }
      if (p.kind === 'item' && sim.raw.items[p.id] && sceneEquipment(sim.raw.items[p.id])) {
        return putInTemp({ ...scene, nextUid: p.uid + 1 }, p);
      }
      return { error: t('无法放置在该位置') };
    }
    case 'deploy': {
      const ctx = scenePlacementCtx(scene, stage, sim.raw);
      const nextDir = DIRS.includes(action.dir) ? action.dir : piece?.dir;
      if (piece?.kind !== 'chess') return { error: t('无法部署在该位置') };
      if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) return { error: deployRefuseReason(ctx, sim.raw, piece, row, col) };
      if (piece.row === row && piece.col === col) {
        return { scene: nextDir && nextDir !== piece.dir ? updatePiece(scene, { ...piece, dir: nextDir }) : scene };
      }
      const [sr, sc] = stageCoordOf(scene, row, col);
      if (reserved.has(grid.key(sr, sc)) || at(scene.enemies, row, col)) return { error: t('该位置已有单位') };
      const occ = at(scene.board, row, col);
      if (occ) {
        if (piece.row == null) {
          const handIdx = scene.hand.findIndex(p => p?.uid === piece.uid);
          if (handIdx < 0) return { error: t('找不到该单位') };
          const { row: _or, col: _oc, ...occBench } = occ;
          const hand = scene.hand.slice();
          hand[handIdx] = occBench;
          const board = scene.board.map(p => p.uid === occ.uid ? { ...piece, row, col, dir: nextDir } : p);
          return { scene: { ...scene, hand, board } };
        }
        if (!tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col)) return { error: t('交换后的单位无法部署在原位置') };
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
      if (!piece || piece.kind !== 'chess' || piece.row != null || !Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) {
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
    case 'moveTemp': {
      const idx = action.idx;
      const cur = Array.isArray(scene.temp) ? scene.temp : Array(GEO.TEMP_SIZE).fill(null);
      if (!piece || piece.kind !== 'item' || !Number.isInteger(idx) || idx < 0 || idx >= GEO.TEMP_SIZE) {
        return { error: t('装备区只能放入装备') };
      }
      const fromIdx = cur.findIndex(p => p?.uid === uid);
      if (fromIdx < 0) return { error: t('找不到该单位') };
      if (fromIdx === idx) return { scene };
      const temp = cur.slice();
      temp[fromIdx] = temp[idx];
      temp[idx] = piece;
      return { scene: { ...scene, temp } };
    }
    case 'equip': {
      const target = findPiece(scene, action.target);
      const replaceUid = Number.isInteger(action.replaceUid) ? action.replaceUid : null;
      const check = canEquipPiece(sim.raw, piece, target, config, { allowReplace: replaceUid != null });
      if (!check.ok) return { error: check.error };
      let nextItems;
      if (check.needsReplace) {
        if (replaceUid == null || !target.items.some(it => it.uid === replaceUid)) return { error: t('该干员的装备栏已满') };
        nextItems = target.items.map(it => it.uid === replaceUid ? piece : it);
      } else {
        nextItems = [...target.items, piece];
      }
      return { scene: updatePiece(removePiece(scene, uid), { ...target, items: nextItems }) };
    }
    case 'unequip': {
      const item = piece?.items?.find(p => p.uid === action.itemUid);
      if (!item) break;
      return putInTemp(updatePiece(scene, { ...piece, items: piece.items.filter(p => p !== item) }), item);
    }
    case 'retreat': {
      if (piece?.row == null) break;
      const idx = action.idx;
      const occ = Number.isInteger(idx) && idx >= 0 && idx < GEO.HAND_SIZE ? scene.hand[idx] : null;
      if (occ?.kind === 'chess') {
        const ctx = scenePlacementCtx(scene, stage, sim.raw);
        if (!tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col)) return { error: t('交换后的单位无法部署在原位置') };
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
      if (scene.fieldMode === 'boss') {
        return { error: t('Boss 战场景不可自定义摆放敌人，请在敌人列表中选择 Boss') };
      }
      const enemy = sim.ds.getEnemy(action.id);
      const err = enemyTileAllowed(enemy, row, col, scene, terrain);
      if (err === 'bad_tile') return { error: t('无法放置在该位置') };
      if (err === 'occupied') return { error: t('该位置已有单位') };
      if (err === 'no_route') return { error: t('敌人无法从该位置前往蓝门') };
      const p = { uid: scene.nextUid, kind: 'enemy', id: action.id, motion: enemy.motion, row, col };
      return { scene: { ...scene, nextUid: p.uid + 1, enemies: [...scene.enemies, p] } };
    }
    case 'selectBoss': {
      if (scene.fieldMode !== 'boss') return { error: t('当前不是 Boss 战场景') };
      const bossTable = bosses || sim.raw?.bosses || null;
      const requestedMode = action.bossModeId ?? scene.bossModeId;
      const info = stageBosses(sim.raw, config, bossTable, scene.stageId, requestedMode);
      const nextBossId = action.bossId === undefined ? scene.bossId : action.bossId;
      if (nextBossId != null && !info.bosses.some(b => b.bossId === nextBossId)) {
        if (action.bossId === undefined) {
          return { scene: { ...scene, bossModeId: info.modeId, bossId: null, enemies: [] } };
        }
        return { error: t('该地图不可选择此 Boss') };
      }
      return { scene: { ...scene, bossModeId: info.modeId, bossId: nextBossId, enemies: [] } };
    }
    case 'setBondLayers': {
      const bond = sim.raw.bonds?.[action.bondId];
      if (!bond) return { error: t('找不到该盟约') };
      if (bond.noStack) return { error: t('该盟约不支持修改层数') };
      const nextLayers = clampBondLayers(action.layers);
      return { scene: { ...scene, bondLayers: { ...(scene.bondLayers || {}), [action.bondId]: nextLayers } } };
    }
    case 'remove':
      return { scene: { ...removePiece(scene, uid), enemies: scene.enemies.filter(p => p.uid !== uid) } };
  }
  return { error: t('找不到该单位') };
}
