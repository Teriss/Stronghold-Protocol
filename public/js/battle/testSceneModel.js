import { BOND_LAYER_CAP, GEO } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { checkDiyPick, diyModuleOf, diyPool, diyRecord, diySlot, diySlotIds, diyTokenOwner, isDiyModule, isPrototypePick } from '../../../shared/diy.js';
import { chessIsDiy, equipmentCapacity, itemForbidsDiy } from '../../../shared/itemRules.js';
import { attackRangeGrid, loadoutRecord, resolveRecordLoadout } from '../../../shared/loadoutRecord.js';
import { grantedBondsByMorph } from '../../../shared/plugins/rules.js';
import { CULTIVATE_DEFAULT, POTENTIAL_DEFAULT, atPotential, isCultivate, isPotential } from '../../../shared/potential.js';
import { MODULE_NONE, charPotentialChanges, loadoutOptions } from '../../../shared/protocol.js';
import { unitForm } from '../../../shared/standIn.js';
import { summonPlacementGrid } from '../../../shared/summonPlacement.js';
import { DEFAULT_VERSION, versionOfData } from '../../../shared/versions.js';
import { rangeTiles } from '../ui/facing.js';
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
const SWITCH_EFFECTS = new Set([
  'act3autochess_gar_effect_switchcharinhand[trigger]',
  'act3autochess_gar_effect_switchhand_triggergar',
]);

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

/** Resolve a token record from standard tokens.json or DIY backups.tokens. */
export function tokenRecordOf(raw, tokenId) {
  if (typeof tokenId !== 'string' || !tokenId) return null;
  return raw?.tokens?.[tokenId] || raw?.backups?.tokens?.[tokenId] || null;
}

const posIntOr = (v, fb) => (Number.isInteger(v) && v > 0 ? v : fb);

/** Placeable summons `{ tokenId, count }[]` granted when `piece` is deployed on the board (mirrors gamedata/diy placeableTokens). */
export function placeableTokensOf(raw, piece) {
  if (!raw?.chess || piece?.kind !== 'chess') return [];
  const baseRec = raw.chess[piece.id];
  if (!baseRec) return [];
  const st = pieceConfigState(raw, piece);
  if (!st) return [];
  const rec = chessRecordOf(raw, piece);
  if (!rec || !Array.isArray(rec.tokens) || !rec.tokens.length) return [];
  const out = [];
  if (baseRec.isDiy) {
    const ownerKey = diyTokenOwner(rec.charId, rec.status);
    const activeMod = st.golden && st.moduleId && st.moduleId !== MODULE_NONE ? st.moduleId : null;
    for (const tid of rec.tokens) {
      const tok = raw.backups?.tokens?.[tid] || raw.tokens?.[tid];
      if (!tok || tok.kind !== 'summon' || tok.placeable !== true) continue;
      const vs = tok.variants && typeof tok.variants === 'object' ? tok.variants : {};
      const v = vs[ownerKey] ? atPotential(vs[ownerKey], st.isProto ? null : st.potential) : null;
      if (v) {
        const alt = Number.isInteger(st.skillIndex) && v.bySkill ? v.bySkill[st.skillIndex] : null;
        const src = Array.isArray(alt?.sources) ? alt.sources : Array.isArray(v.sources) ? v.sources : [];
        if (!src.includes('talent') && !src.includes('skill')) continue;
      }
      const vm = v && activeMod && v.byModule && typeof v.byModule === 'object' ? v.byModule[activeMod] ?? null : null;
      const count = posIntOr(vm?.stats?.deployLimit, posIntOr(v?.stats?.deployLimit, posIntOr(tok.deployLimit, 1)));
      out.push({ tokenId: tid, count: Math.min(count, 9) });
    }
    return out;
  }
  const activeMod = st.golden && st.moduleId && st.moduleId !== MODULE_NONE ? st.moduleId : null;
  for (const tid of rec.tokens) {
    const tok = raw.tokens?.[tid];
    if (!tok || tok.kind !== 'summon' || tok.placeable !== true) continue;
    const vs = tok.variants && typeof tok.variants === 'object' ? tok.variants : {};
    const v0 = vs[piece.id] ?? vs[String(piece.id).replace(/_b$/, '_a')] ?? null;
    const v = v0 ? atPotential(v0, st.potential) : null;
    if (v) {
      const alt = Number.isInteger(st.skillIndex) && v.bySkill ? v.bySkill[st.skillIndex] : null;
      const src = Array.isArray(alt?.sources) ? alt.sources : Array.isArray(v.sources) ? v.sources : [];
      if (!src.includes('talent') && !src.includes('skill')) continue;
    }
    const vm = v && activeMod && v.byModule && typeof v.byModule === 'object' ? v.byModule[activeMod] ?? null : null;
    const count = posIntOr(vm?.stats?.deployLimit, posIntOr(v?.stats?.deployLimit, posIntOr(tok.deployLimit, 1)));
    out.push({ tokenId: tid, count: Math.min(count, 9) });
  }
  return out;
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

/** Searchable bond names for an operator (localized, translated via localeName, and raw Chinese). */
export function operatorBondNames(raw, rec, { getBond = null, localeName = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = text => {
    if (typeof text !== 'string' || !text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };
  for (const bondId of Array.isArray(rec?.bonds) ? rec.bonds : []) {
    const rawName = raw?.bonds?.[bondId]?.name;
    push(getBond?.(bondId)?.name);
    if (rawName) {
      push(localeName?.(rawName));
      push(rawName);
    }
  }
  return out;
}

/** Match a catalogue row against a search query (whitespace-separated terms, each matching any search text). */
export function matchesCatalogueQuery(texts, query) {
  const tokens = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = (Array.isArray(texts) ? texts : [])
    .filter(text => typeof text === 'string' && text)
    .map(text => text.toLocaleLowerCase());
  return tokens.every(token => hay.some(text => text.includes(token)));
}

export function emptyScene(stageId = DEFAULT_STAGE, fieldMode = 'normal', { bossModeId = null, bossId = null, bossSide = 'L' } = {}) {
  const boss = fieldMode === 'boss';
  return {
    stageId,
    fieldMode: boss ? 'boss' : 'normal',
    bossModeId: boss ? bossModeId : null,
    bossId: boss ? bossId : null,
    bossSide: boss && bossSide === 'R' ? 'R' : 'L',
    bondLayers: {},
    hand: Array(GEO.HAND_SIZE).fill(null),
    temp: Array(GEO.TEMP_SIZE).fill(null),
    board: [],
    enemies: [],
    nextUid: 1,
  };
}

export function bossSideOf(scene) {
  return scene?.fieldMode === 'boss' && scene?.bossSide === 'R' ? 'R' : 'L';
}

export function deployFieldOfScene(scene) {
  return scene?.fieldMode === 'boss' ? (bossSideOf(scene) === 'R' ? 'bossR' : 'bossL') : 'normal';
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
  if (Array.isArray(bond?.thresholds) && bond.thresholds.length) return bond.thresholds.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (Number.isFinite(bond?.activeCount)) return [bond.activeCount];
  return [];
}

function bondTierFor(bond, count) {
  if (!bond || !(count > 0)) return 0;
  const th = bondThresholds(bond);
  if (bond.thresholdTemplate === 'count_threshold_downward' || bond.maxCount != null) {
    const min = th[0] ?? 1;
    const max = Number.isFinite(bond.maxCount) ? bond.maxCount : min;
    return count >= min && count <= max ? 1 : 0;
  }
  let tier = 0;
  for (const n of th) if (count >= n) tier++;
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

const BOSS_MID_COL = (GEO.BOSS_RECT.c0 + GEO.BOSS_RECT.c1) / 2;

function resolveSideTemplate(raw, templateId, side) {
  if (side === 'R' && templateId && /_s$/.test(templateId)) {
    const pairId = templateId.replace(/_s$/, '');
    if (raw?.waves?.[pairId]) return { templateId: pairId, tpl: raw.waves[pairId], paired: true };
  }
  const tpl = templateId ? raw?.waves?.[templateId] : null;
  return { templateId, tpl, paired: Boolean(templateId && !/_s$/.test(templateId)) };
}

function templateEntriesForSide(tpl, side) {
  const list = Array.isArray(tpl?.spawns) ? tpl.spawns : [];
  const routes = Array.isArray(tpl?.routes) ? tpl.routes : [];
  const hasRightEscorts = side === 'R' && list.some((s) => {
    if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) return false;
    if (s.tag === 'boss' || s.tag === 'part') return false;
    const end = routes[Number.isInteger(s.routeIndex) ? s.routeIndex : 0]?.end;
    return Array.isArray(end) && end[1] > BOSS_MID_COL;
  });
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
    if (hasRightEscorts && s.tag !== 'boss' && s.tag !== 'part') {
      const end = routes[Number.isInteger(s.routeIndex) ? s.routeIndex : 0]?.end;
      if (Array.isArray(end) && end[1] < BOSS_MID_COL) continue;
    }
    out.push({ s, actionIndex: i });
  }
  return out;
}

/** Official selectable bosses for a stage and difficulty, with their real wave templates and HP pools. */
export function stageBosses(raw, config, bosses, stageId, preferredModeId = null, bossSide = 'L') {
  const side = bossSide === 'R' ? 'R' : 'L';
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
      const baseTemplateId = tplInfo?.template || null;
      const { templateId, tpl } = resolveSideTemplate(raw, baseTemplateId, side);
      if (!tpl) continue;
      const round = Number.isInteger(tplInfo?.round) ? tplInfo.round : (hidden ? 15 : 14);
      const escorts = [];
      const counts = new Map();
      for (const { s } of templateEntriesForSide(tpl, side)) {
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
  const side = bossSideOf(scene);
  const info = stageBosses(raw, config, bosses, scene.stageId, scene.bossModeId, side);
  const picked = info.bosses.find(b => b.bossId === scene.bossId);
  if (!picked) return null;
  const tpl = raw?.waves?.[picked.templateId];
  if (!tpl) return null;
  const scale = enemyScaleOf(config, info.modeId, picked.round);
  const routes = Array.isArray(tpl.routes) ? tpl.routes.slice() : [];
  const spawns = [];
  for (const { s, actionIndex } of templateEntriesForSide(tpl, side)) {
    const key = s.key ?? s.enemyKey;
    if (typeof key !== 'string' || key === ACLOON || !raw?.enemies?.[key]) continue;
    const tag = s.tag ?? null;
    const isBoss = tag === 'boss';
    const isPart = tag === 'part';
    const count = Math.max(1, Math.min(50, Number.isInteger(s.count) ? s.count : 1));
    const interval = Math.max(0, Number(s.interval) || 0);
    let time = Math.max(0, Number(s.time) || 0);
    let routeIndex = Number.isInteger(s.routeIndex) ? s.routeIndex : 0;
    if (isBoss && side === 'R') {
      const mirrorBranch = tpl.branches?.boss_battle_multi_player?.[0]?.find(b => (b.key ?? b.enemyKey) === key);
      const extraRoute = mirrorBranch ? tpl.extraRoutes?.[mirrorBranch.routeIndex] : null;
      if (extraRoute) {
        routeIndex = routes.length;
        routes.push(extraRoute);
        time = Math.max(0, Number(mirrorBranch.time ?? time) || 0);
      }
    }
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
      actionIndex,
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
    routes,
    overrides: tpl.overrides && typeof tpl.overrides === 'object' ? tpl.overrides : {},
  };
}

function boardOrdered(board) {
  return (Array.isArray(board) ? board.slice() : []).sort((a, b) => (b.row - a.row) || (a.col - b.col) || (a.uid - b.uid));
}

function unitSpecOf(raw, p) {
  if (p.kind === 'token') {
    return {
      uid: p.uid,
      kind: 'token',
      tokenId: p.id,
      row: p.row,
      col: p.col,
      dir: p.dir || 'RIGHT',
      ownerUid: p.ownerUid,
    };
  }
  const rec = raw?.chess?.[p.id];
  const isProto = Boolean(rec?.isDiy && p.diy && isPrototypePick(raw, rec.tier, p.diy.charId));
  const golden = Boolean(p.golden || rec?.isGolden);
  const potential = isPotential(p.potential) ? p.potential : POTENTIAL_DEFAULT;
  const cultivate = isCultivate(p.cultivate) ? p.cultivate : CULTIVATE_DEFAULT;
  return {
    uid: p.uid,
    kind: p.kind,
    chessId: p.id,
    row: p.row,
    col: p.col,
    dir: p.dir,
    items: (p.items || []).map(item => item.id),
    ...(!rec?.isDiy && Number.isInteger(p.skillIndex) ? { skillIndex: p.skillIndex } : null),
    ...(!rec?.isDiy && golden && typeof p.moduleId === 'string' ? { moduleId: p.moduleId } : null),
    ...(p.diy ? { diy: p.diy } : null),
    ...(typeof p.skin === 'string' && p.skin ? { skin: p.skin } : null),
    ...(!isProto ? { potential, cultivate } : null),
  };
}

function regulationBenchFor(raw, scene) {
  if (!raw?.garrisons || !scene) return null;
  let needsBench = false;
  for (const p of scene.board || []) {
    if (!p || p.kind !== 'chess') continue;
    const rec = raw.chess?.[p.id];
    const gids = rec?.garrisonIds;
    if (!Array.isArray(gids)) continue;
    for (const gid of gids) {
      if (SWITCH_EFFECTS.has(raw.garrisons[gid]?.effectKey)) { needsBench = true; break; }
    }
    if (needsBench) break;
  }
  if (!needsBench) return null;
  const bench = [];
  for (let i = 0; i < (scene.hand || []).length; i++) {
    const p = scene.hand[i];
    if (!p || p.kind !== 'chess') continue;
    const rec = chessRecordOf(raw, p);
    const u = unitSpecOf(raw, p);
    delete u.row;
    delete u.col;
    u.idx = i;
    u.dir = p.dir || 'RIGHT';
    u.bonds = Array.isArray(rec?.bonds) ? rec.bonds.slice() : [];
    bench.push(u);
  }
  return bench;
}

/** Resolved per-piece loadout / cultivation / skin state for Test Scene editing and UI display. */
export function pieceConfigState(raw, piece) {
  if (!raw?.chess || piece?.kind !== 'chess') return null;
  const baseRec = raw.chess[piece.id];
  if (!baseRec) return null;
  const golden = Boolean(piece.golden || baseRec.isGolden);
  const skin = typeof piece.skin === 'string' && piece.skin ? piece.skin : null;
  if (baseRec.isDiy) {
    const slot = diySlot(piece.id, raw);
    const charId = piece.diy?.charId || null;
    if (!slot || !charId) return null;
    const isProto = isPrototypePick(raw, slot.tier, charId);
    const defPick = defaultDiyPick(raw, slot.baseId, charId);
    const skillIndex = Number.isInteger(piece.diy.skillIndex) ? piece.diy.skillIndex : defPick?.skillIndex ?? null;
    const moduleId = golden ? (piece.diy.uniEquipId ?? MODULE_NONE) : null;
    const defModuleId = golden ? (defPick?.uniEquipId ?? MODULE_NONE) : null;
    const potAllowed = !isProto && charPotentialChanges(raw, charId);
    const potential = potAllowed && isPotential(piece.potential) ? piece.potential : POTENTIAL_DEFAULT;
    const cultivate = !isProto && isCultivate(piece.cultivate) ? piece.cultivate : CULTIVATE_DEFAULT;
    const changed = Boolean(
      (!isProto && defPick && skillIndex !== defPick.skillIndex)
      || (!isProto && golden && defPick && moduleId !== defModuleId)
      || (!isProto && potential !== POTENTIAL_DEFAULT)
      || (!isProto && cultivate !== CULTIVATE_DEFAULT)
      || skin !== null,
    );
    return {
      isDiy: true, isProto, golden, baseId: slot.baseId, goldenId: slot.goldenId, charId,
      skillIndex, defaultSkill: defPick?.skillIndex ?? null,
      moduleId, defaultModule: defModuleId,
      potential, cultivate, skin, changed,
    };
  }
  const baseId = baseRec.baseId || piece.id;
  const normalRec = raw.chess[baseId] || baseRec;
  const goldenId = normalRec.goldenId || (golden ? piece.id : null);
  const goldenRec = goldenId ? raw.chess[goldenId] || null : null;
  const opt = loadoutOptions(normalRec, goldenRec);
  const skillIndex = Number.isInteger(piece.skillIndex) && opt.skills.includes(piece.skillIndex) ? piece.skillIndex : opt.defaultSkill;
  const moduleId = golden
    ? (typeof piece.moduleId === 'string' && opt.modules.includes(piece.moduleId) ? piece.moduleId : opt.defaultModule)
    : null;
  const charId = normalRec.charId || baseRec.charId || null;
  const potAllowed = charId ? charPotentialChanges(raw, charId) : false;
  const potential = potAllowed && isPotential(piece.potential) ? piece.potential : POTENTIAL_DEFAULT;
  const cultivate = isCultivate(piece.cultivate) ? piece.cultivate : CULTIVATE_DEFAULT;
  const changed = Boolean(
    (skillIndex != null && skillIndex !== opt.defaultSkill)
    || (golden && moduleId != null && moduleId !== opt.defaultModule)
    || potential !== POTENTIAL_DEFAULT
    || cultivate !== CULTIVATE_DEFAULT
    || skin !== null,
  );
  return {
    isDiy: false, isProto: false, golden, baseId, goldenId, charId,
    skillIndex, defaultSkill: opt.defaultSkill,
    moduleId, defaultModule: golden ? opt.defaultModule : null,
    potential, cultivate, skin, changed,
  };
}

/** Single-piece `{ [baseId]: { skill?, module? } }` map consumed by DetailPanel / inspectRange / LoadoutStats. */
export function pieceLoadoutMap(raw, piece) {
  const st = pieceConfigState(raw, piece);
  if (!st || st.isDiy) return null;
  const entry = {};
  if (st.skillIndex != null && st.skillIndex !== st.defaultSkill) entry.skill = st.skillIndex;
  if (st.golden && st.moduleId != null && st.moduleId !== st.defaultModule) entry.module = st.moduleId;
  return Object.keys(entry).length ? { [st.baseId]: entry } : null;
}

/** Single-piece `{ [charId]: { potential?, cultivate? } }` map consumed by DetailPanel / CultivationSection / LoadoutStats. */
export function pieceOpsMap(raw, piece) {
  const st = pieceConfigState(raw, piece);
  if (!st || st.isProto || !st.charId) return null;
  const entry = {};
  if (st.potential !== POTENTIAL_DEFAULT) entry.potential = st.potential;
  if (st.cultivate !== CULTIVATE_DEFAULT) entry.cultivate = st.cultivate;
  return Object.keys(entry).length ? { [st.charId]: entry } : null;
}

export function sceneSpec(sim, scene, goal, { config = null, bosses = null } = {}) {
  const cfg = config || sim.raw?.config || null;
  const bossTable = bosses || sim.raw?.bosses || null;
  const boss = scene.fieldMode === 'boss';
  const dp = dpFlagsOf(cfg);
  const versionId = versionOfData({ config: cfg || sim.raw?.config });
  const versionOpt = versionId !== DEFAULT_VERSION ? { version: versionId } : null;
  const fallbackMode = defaultModeOf(cfg);
  const side = bossSideOf(scene);
  const bench = regulationBenchFor(sim.raw, scene);
  const playerInput = {
    playerId: PLAYER_ID,
    side,
    ...(boss && side === 'R' ? { colOffset: 8 } : null),
    seat: 0,
    bonds: sceneBondSnapshot(sim.raw, scene),
    units: boardOrdered(scene.board).map(p => unitSpecOf(sim.raw, p)),
    ...(bench ? { bench } : null),
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
export function sceneTerrain(sim, stageId, fieldMode = 'normal', bossSide = 'L') {
  const mode = fieldMode === 'boss' ? 'boss' : 'normal';
  const side = mode === 'boss' && bossSide === 'R' ? 'R' : 'L';
  const probe = sim.spec.createBattleFromSpec(sceneSpec(sim, emptyScene(stageId, mode, { bossSide: side })), sim.ds, { quiet: true });
  probe.start();
  const { grid } = probe;
  const ends = grid.specialTiles('end');
  const goal = (mode === 'boss' ? ends.find(([, c]) => (side === 'R' ? c > BOSS_MID_COL : c <= BOSS_MID_COL)) : null) || ends[0];
  const reserved = new Set(probe.units.filter(u => u.alive && u.deployed && grid.inRect(u.y, u.x))
    .map(u => grid.key(u.y, u.x)));
  return { grid, goal, reserved, fieldMode: mode, deployField: mode === 'boss' ? (side === 'R' ? 'bossR' : 'bossL') : 'normal' };
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
    getToken: id => tokenRecordOf(raw, id),
    backups: raw.backups || null,
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

function resolvedOwnerRecord(raw, owner) {
  const rec = chessRecordOf(raw, owner);
  if (!rec) return null;
  if (raw.chess?.[owner.id]?.isDiy) return rec;
  const st = pieceConfigState(raw, owner);
  if (!st) return rec;
  return loadoutRecord(rec, resolveRecordLoadout(rec, { skillIndex: st.skillIndex, moduleId: st.moduleId })) || rec;
}

function ownerRangeKeysFor(raw, scene, tokenPiece, ownerOverride = null, placementGrid = null) {
  const owner = ownerOverride || scene.board.find(p => p.kind === 'chess' && p.uid === tokenPiece.ownerUid);
  if (!owner || owner.row == null || owner.col == null) return null;
  const rec = resolvedOwnerRecord(raw, owner);
  if (!rec) return null;
  const grid = placementGrid || attackRangeGrid(rec) || rec.rangeGrid;
  return new Set(rangeTiles(grid, owner.row, owner.col, owner.dir || 'RIGHT').map(([r, c]) => `${r},${c}`));
}

function tokenRangeCheck(raw, scene, tokenPiece, row, col, ownerOverride = null) {
  if (tokenPiece?.kind !== 'token') return { ok: true };
  const grid = summonPlacementGrid(tokenPiece.id);
  const tokRec = tokenRecordOf(raw, tokenPiece.id);
  if (grid || tokRec?.ownerRange === true) {
    const keys = ownerRangeKeysFor(raw, scene, tokenPiece, ownerOverride, grid);
    if (!keys || !keys.has(`${row},${col}`)) {
      return { ok: false, error: grid ? t('只能部署在召唤者相邻四格') : t('只能部署在召唤者攻击范围内') };
    }
  }
  if (tokRec?.ownerRangeOutside === true) {
    const keys = ownerRangeKeysFor(raw, scene, tokenPiece, ownerOverride, null);
    if (keys && keys.has(`${row},${col}`)) {
      return { ok: false, error: t('只能部署在召唤者攻击范围外') };
    }
  }
  return { ok: true };
}

function unitAllowedInScene(baseCtx, raw, scene, piece, row, col, ownerOverride = null) {
  if (!tileAllowsPiece(baseCtx, raw, piece, row, col)) {
    return { ok: false, error: deployRefuseReason(baseCtx, raw, piece, row, col) };
  }
  return tokenRangeCheck(raw, scene, piece, row, col, ownerOverride);
}

function removeTokensOf(scene, ownerUid) {
  return {
    ...scene,
    board: scene.board.filter(p => !(p.kind === 'token' && p.ownerUid === ownerUid)),
    hand: scene.hand.map(p => (p && p.kind === 'token' && p.ownerUid === ownerUid ? null : p)),
  };
}

function returnTokenToHand(scene, tok, preferredIdx = null) {
  const stackIdx = scene.hand.findIndex(p => p && p.kind === 'token' && p.ownerUid === tok.ownerUid && p.id === tok.id);
  if (stackIdx >= 0) {
    const hand = scene.hand.slice();
    const stack = hand[stackIdx];
    hand[stackIdx] = { ...stack, count: (stack.count || 1) + (tok.count || 1) };
    return { scene: { ...scene, hand } };
  }
  const { row: _r, col: _c, ...rest } = tok;
  return putInHand(scene, { ...rest, count: tok.count || 1 }, preferredIdx);
}

function liftTokensOf(scene, ownerUid, keepUid = null) {
  let cur = scene;
  const toLift = cur.board.filter(p => p.kind === 'token' && p.ownerUid === ownerUid && p.uid !== keepUid);
  if (!toLift.length) return { scene: cur };
  cur = { ...cur, board: cur.board.filter(p => !(p.kind === 'token' && p.ownerUid === ownerUid && p.uid !== keepUid)) };
  for (const tok of toLift) {
    const res = returnTokenToHand(cur, tok);
    if (res.error) return res;
    cur = res.scene;
  }
  return { scene: cur };
}

function liftOutOfRangeTokens(raw, scene, ownerUid) {
  let cur = scene;
  const bad = cur.board.filter(p => p.kind === 'token' && p.ownerUid === ownerUid
    && !tokenRangeCheck(raw, cur, p, p.row, p.col).ok);
  if (!bad.length) return { scene: cur };
  const badIds = new Set(bad.map(p => p.uid));
  cur = { ...cur, board: cur.board.filter(p => !badIds.has(p.uid)) };
  for (const tok of bad) {
    const res = returnTokenToHand(cur, tok);
    if (res.error) return res;
    cur = res.scene;
  }
  return { scene: cur };
}

function tokenCountOf(scene, ownerUid, tokenId) {
  let n = 0;
  for (const p of scene.board) if (p.kind === 'token' && p.ownerUid === ownerUid && p.id === tokenId) n += p.count || 1;
  for (const p of scene.hand) if (p && p.kind === 'token' && p.ownerUid === ownerUid && p.id === tokenId) n += p.count || 1;
  return n;
}

function syncTokenSkins(scene, owner) {
  const skin = typeof owner?.skin === 'string' && owner.skin ? owner.skin : null;
  const apply = p => {
    if (!p || p.kind !== 'token' || p.ownerUid !== owner.uid) return p;
    if ((p.skin || null) === skin) return p;
    const next = { ...p };
    if (skin) next.skin = skin;
    else delete next.skin;
    return next;
  };
  return { ...scene, board: scene.board.map(apply), hand: scene.hand.map(apply) };
}

function grantTokensFor(raw, scene, owner) {
  let cur = scene;
  const stock = placeableTokensOf(raw, owner);
  if (!stock.length) return { scene: cur };
  const skin = typeof owner.skin === 'string' && owner.skin ? owner.skin : null;
  for (const { tokenId, count } of stock) {
    const missing = count - tokenCountOf(cur, owner.uid, tokenId);
    if (missing <= 0) continue;
    const stackIdx = cur.hand.findIndex(p => p && p.kind === 'token' && p.ownerUid === owner.uid && p.id === tokenId);
    if (stackIdx >= 0) {
      const hand = cur.hand.slice();
      hand[stackIdx] = { ...hand[stackIdx], count: (hand[stackIdx].count || 1) + missing, ...(skin ? { skin } : null) };
      cur = { ...cur, hand };
      continue;
    }
    const tok = {
      uid: cur.nextUid,
      kind: 'token',
      id: tokenId,
      count: missing,
      ownerUid: owner.uid,
      dir: 'RIGHT',
      ...(skin ? { skin } : null),
    };
    const res = putInHand({ ...cur, nextUid: cur.nextUid + 1 }, tok);
    if (res.error) return res;
    cur = res.scene;
  }
  return { scene: cur };
}

function reconcileTokensFor(raw, scene, owner) {
  const deployed = scene.board.some(p => p.uid === owner.uid);
  const stock = deployed ? placeableTokensOf(raw, owner) : [];
  const remaining = new Map(stock.map(({ tokenId, count }) => [tokenId, count]));
  const keepBoard = new Map();
  for (const p of boardOrdered(scene.board)) {
    if (p.kind !== 'token' || p.ownerUid !== owner.uid) continue;
    const left = remaining.get(p.id) || 0;
    const keep = Math.min(p.count || 1, left);
    if (keep > 0) {
      keepBoard.set(p.uid, keep);
      remaining.set(p.id, left - keep);
    }
  }
  const nextBoard = scene.board.filter(p => !(p.kind === 'token' && p.ownerUid === owner.uid) || keepBoard.has(p.uid))
    .map(p => (keepBoard.has(p.uid) ? { ...p, count: keepBoard.get(p.uid) } : p));
  const nextHand = scene.hand.map(p => {
    if (!p || p.kind !== 'token' || p.ownerUid !== owner.uid) return p;
    const left = remaining.get(p.id) || 0;
    const keep = Math.min(p.count || 1, left);
    if (keep <= 0) return null;
    remaining.set(p.id, left - keep);
    return keep === (p.count || 1) ? p : { ...p, count: keep };
  });
  let cur = syncTokenSkins({ ...scene, board: nextBoard, hand: nextHand }, owner);
  if (deployed) {
    const granted = grantTokensFor(raw, cur, owner);
    if (granted.error) return granted;
    cur = granted.scene;
    const lifted = liftOutOfRangeTokens(raw, cur, owner.uid);
    if (lifted.error) return lifted;
    cur = lifted.scene;
  }
  return { scene: cur };
}

function savedPiecePatch(raw, piece, saved) {
  if (!raw?.chess || piece?.kind !== 'chess' || !saved) return piece;
  const baseRec = raw.chess[piece.id];
  if (!baseRec) return piece;
  const golden = Boolean(piece.golden || baseRec.isGolden);
  const skins = saved.skins && typeof saved.skins === 'object' ? saved.skins : {};
  const ops = saved.ops && typeof saved.ops === 'object' ? saved.ops : {};
  const entries = saved.entries && typeof saved.entries === 'object' ? saved.entries : {};
  const byChar = saved.byChar && typeof saved.byChar === 'object' ? saved.byChar : {};
  const diyPicks = saved.diy && typeof saved.diy === 'object' ? saved.diy : {};
  let nextSkill = undefined;
  let nextMod = undefined;
  let nextPot = undefined;
  let nextCult = undefined;
  let nextSkin = undefined;
  let nextDiy = piece.diy;

  if (baseRec.isDiy) {
    const slot = diySlot(piece.id, raw);
    const charId = piece.diy?.charId || null;
    if (!slot || !charId) return piece;
    const isProto = isPrototypePick(raw, slot.tier, charId);
    const defPick = defaultDiyPick(raw, slot.baseId, charId);
    if (!isProto && defPick) {
      let slotPick = null;
      if (diyPicks[slot.baseId]?.charId === charId) slotPick = diyPicks[slot.baseId];
      else {
        for (const v of Object.values(diyPicks)) {
          if (v && v.charId === charId) { slotPick = v; break; }
        }
      }
      let wantSkill = defPick.skillIndex;
      let wantMod = defPick.uniEquipId ?? null;
      if (slotPick) {
        if (Number.isInteger(slotPick.skillIndex)) wantSkill = slotPick.skillIndex;
        wantMod = slotPick.uniEquipId ?? null;
      } else if (Object.hasOwn(byChar, charId) && byChar[charId] && typeof byChar[charId] === 'object') {
        const bc = byChar[charId];
        if (Number.isInteger(bc.skill)) wantSkill = bc.skill;
        if (typeof bc.module === 'string') wantMod = bc.module === MODULE_NONE ? null : bc.module;
      }
      const checked = checkDiyPick(slot.baseId, { charId, skillIndex: wantSkill, uniEquipId: wantMod }, raw);
      if ('ok' in checked) nextDiy = checked.pick;
      else nextDiy = defPick;
      const op = ops[charId];
      if (op && isPotential(op.potential) && op.potential !== POTENTIAL_DEFAULT && charPotentialChanges(raw, charId)) {
        nextPot = op.potential;
      }
      if (op && isCultivate(op.cultivate) && op.cultivate !== CULTIVATE_DEFAULT) {
        nextCult = op.cultivate;
      }
    }
    if (typeof skins[charId] === 'string' && skins[charId]) nextSkin = skins[charId];
  } else {
    const baseId = baseRec.baseId || piece.id;
    const normalRec = raw.chess[baseId] || baseRec;
    const goldenRec = normalRec.goldenId ? raw.chess[normalRec.goldenId] || null : (golden ? baseRec : null);
    const charId = normalRec.charId || baseRec.charId || null;
    const opt = loadoutOptions(normalRec, goldenRec);
    const choice = (Object.hasOwn(entries, baseId) ? entries[baseId] : null)
      || (charId && Object.hasOwn(byChar, charId) ? byChar[charId] : null);
    if (choice && typeof choice === 'object') {
      if (Number.isInteger(choice.skill) && opt.skills.includes(choice.skill) && choice.skill !== opt.defaultSkill) {
        nextSkill = choice.skill;
      }
      if (golden && typeof choice.module === 'string' && opt.modules.includes(choice.module) && choice.module !== opt.defaultModule) {
        nextMod = choice.module;
      }
    }
    if (charId) {
      const op = ops[charId];
      if (op && isPotential(op.potential) && op.potential !== POTENTIAL_DEFAULT && charPotentialChanges(raw, charId)) {
        nextPot = op.potential;
      }
      if (op && isCultivate(op.cultivate) && op.cultivate !== CULTIVATE_DEFAULT) {
        nextCult = op.cultivate;
      }
      if (typeof skins[charId] === 'string' && skins[charId]) nextSkin = skins[charId];
    }
  }

  const sameDiy = piece.diy === nextDiy || (
    Boolean(piece.diy) && Boolean(nextDiy)
    && piece.diy.charId === nextDiy.charId
    && piece.diy.skillIndex === nextDiy.skillIndex
    && (piece.diy.uniEquipId ?? null) === (nextDiy.uniEquipId ?? null)
  );
  if (
    piece.skillIndex === nextSkill
    && piece.moduleId === nextMod
    && piece.potential === nextPot
    && piece.cultivate === nextCult
    && piece.skin === nextSkin
    && sameDiy
  ) return piece;

  const next = { ...piece };
  if (nextSkill === undefined) delete next.skillIndex; else next.skillIndex = nextSkill;
  if (nextMod === undefined) delete next.moduleId; else next.moduleId = nextMod;
  if (nextPot === undefined) delete next.potential; else next.potential = nextPot;
  if (nextCult === undefined) delete next.cultivate; else next.cultivate = nextCult;
  if (nextSkin === undefined) delete next.skin; else next.skin = nextSkin;
  if (baseRec.isDiy && nextDiy) next.diy = nextDiy;
  return next;
}

/**
 * Project the unified browser loadout stores (`entries`, `byChar`, `ops`, `diy`, `skins`) onto every chess piece in
 * a Test Scene, reconciling summons and token skins for any deployed owners whose configuration changed.
 */
export function applySavedLoadout(raw, scene, saved) {
  if (!raw?.chess || !scene || !saved) return scene;
  const changedBoard = [];
  let anyChanged = false;
  const nextHand = (scene.hand || []).map(p => {
    if (!p || p.kind !== 'chess') return p;
    const np = savedPiecePatch(raw, p, saved);
    if (np !== p) anyChanged = true;
    return np;
  });
  const nextBoard = (scene.board || []).map(p => {
    if (!p || p.kind !== 'chess') return p;
    const np = savedPiecePatch(raw, p, saved);
    if (np !== p) { anyChanged = true; changedBoard.push(np); }
    return np;
  });
  if (!anyChanged) return scene;
  let cur = { ...scene, hand: nextHand, board: nextBoard };
  for (const owner of changedBoard) {
    const res = reconcileTokensFor(raw, cur, owner);
    cur = res.scene ? res.scene : syncTokenSkins(cur, owner);
  }
  return cur;
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
      if (piece.kind === 'token') {
        const hasStack = scene.hand.some(p => p && p.kind === 'token' && p.ownerUid === piece.ownerUid && p.id === piece.id);
        return hasStack || scene.hand.includes(null);
      }
      if (!occ) return true;
      if (occ.kind === 'chess') {
        const ctx = scenePlacementCtx(scene, stage, sim.raw);
        return tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col);
      }
      return scene.hand.some(p => !p || (p.kind === 'token' && p.ownerUid === piece.uid));
    }
    return true;
  }
  if (target.area === 'board') {
    const { row, col } = target;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
    const occ = at(scene.board, row, col);
    if (piece.kind === 'item') return !!occ && canEquipPiece(sim.raw, piece, occ, config, { allowReplace: true }).ok;
    if (piece.kind !== 'chess' && piece.kind !== 'token') return false;
    if (piece.row === row && piece.col === col) return true;
    const ctx = scenePlacementCtx(scene, stage, sim.raw);
    const { grid, reserved } = terrain;
    const [sr, sc] = stageCoordOf(scene, row, col);
    if (reserved.has(grid.key(sr, sc)) || at(scene.enemies, row, col)) return false;
    if (piece.kind === 'token') {
      if (piece.row == null) {
        if (occ) return false;
        const ownerDeployed = scene.board.some(p => p.kind === 'chess' && p.uid === piece.ownerUid);
        if (Number.isInteger(piece.ownerUid) && !ownerDeployed) return false;
        return unitAllowedInScene(ctx, sim.raw, scene, piece, row, col).ok;
      }
      const ownerSwap = occ && occ.kind === 'chess' && occ.uid === piece.ownerUid
        ? { ...occ, row: piece.row, col: piece.col }
        : null;
      if (!unitAllowedInScene(ctx, sim.raw, scene, piece, row, col, ownerSwap).ok) return false;
      if (occ && !unitAllowedInScene(ctx, sim.raw, scene, occ, piece.row, piece.col).ok) return false;
      return true;
    }
    if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) return false;
    if (occ) {
      if (piece.row == null) return true;
      const ownSummon = occ.kind === 'token' && occ.ownerUid === piece.uid;
      return ownSummon || unitAllowedInScene(ctx, sim.raw, scene, occ, piece.row, piece.col).ok;
    }
    return true;
  }
  return false;
}

/** Board tiles `[[row, col], ...]` to highlight for the active selection, drag, or armed enemy. */
export function legalTilesFor(scene, focus, { sim, terrain, config }) {
  const tiles = [];
  if (!focus) return tiles;
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
  if (piece.kind === 'chess' || piece.kind === 'token') {
    const F = GEO.FIELD;
    for (let row = F.r0; row <= F.r1; row++) {
      for (let col = F.c0; col <= F.c1; col++) {
        if (canPlaceInScene(scene, piece.uid, { area: 'board', row, col }, { sim, terrain, config })) tiles.push([row, col]);
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
      const nextDir = DIRS.includes(action.dir) ? action.dir : (piece?.dir || 'RIGHT');
      if (piece?.kind !== 'chess' && piece?.kind !== 'token') return { error: t('无法部署在该位置') };
      if (piece.row === row && piece.col === col) {
        if (!nextDir || nextDir === piece.dir) return { scene };
        const rotated = updatePiece(scene, { ...piece, dir: nextDir });
        return piece.kind === 'chess' ? liftOutOfRangeTokens(sim.raw, rotated, piece.uid) : { scene: rotated };
      }
      const [sr, sc] = stageCoordOf(scene, row, col);
      if (reserved.has(grid.key(sr, sc)) || at(scene.enemies, row, col)) return { error: t('该位置已有单位') };
      const occ = at(scene.board, row, col);
      if (piece.kind === 'token') {
        const ownerSwap = piece.row != null && occ && occ.kind === 'chess' && occ.uid === piece.ownerUid
          ? { ...occ, row: piece.row, col: piece.col }
          : null;
        const allowed = unitAllowedInScene(ctx, sim.raw, scene, piece, row, col, ownerSwap);
        if (!allowed.ok) return { error: allowed.error };
        if (piece.row != null) {
          if (occ) {
            const occAllowed = unitAllowedInScene(ctx, sim.raw, scene, occ, piece.row, piece.col);
            if (!occAllowed.ok) return { error: t('交换后的单位无法部署在原位置') };
            let next = {
              ...scene,
              board: scene.board.map(p => p.uid === piece.uid ? { ...piece, row, col, dir: nextDir }
                : p.uid === occ.uid ? { ...occ, row: piece.row, col: piece.col } : p),
            };
            if (occ.kind === 'chess') {
              const lifted = liftTokensOf(next, occ.uid, piece.uid);
              if (lifted.error) return lifted;
              next = lifted.scene;
            }
            return { scene: next };
          }
          return { scene: updatePiece(scene, { ...piece, row, col, dir: nextDir }) };
        }
        if (occ) return { error: t('该位置已有单位') };
        if (Number.isInteger(piece.ownerUid) && !scene.board.some(p => p.kind === 'chess' && p.uid === piece.ownerUid)) {
          return { error: t('召唤者尚未部署') };
        }
        if ((piece.count || 1) > 1) {
          const hand = scene.hand.map(p => (p?.uid === piece.uid ? { ...p, count: p.count - 1 } : p));
          const placed = { ...piece, uid: scene.nextUid, count: 1, row, col, dir: nextDir };
          return { scene: { ...scene, nextUid: scene.nextUid + 1, hand, board: [...scene.board, placed] } };
        }
        const detached = removePiece(scene, piece.uid);
        return { scene: { ...detached, board: [...detached.board, { ...piece, count: 1, row, col, dir: nextDir }] } };
      }
      if (!tileAllowsPiece(ctx, sim.raw, piece, row, col)) return { error: deployRefuseReason(ctx, sim.raw, piece, row, col) };
      if (occ) {
        if (piece.row == null) {
          const handIdx = scene.hand.findIndex(p => p?.uid === piece.uid);
          if (handIdx < 0) return { error: t('找不到该单位') };
          const deployedPiece = { ...piece, row, col, dir: nextDir };
          let next = { ...scene, board: scene.board.filter(p => p.uid !== occ.uid), hand: scene.hand.slice() };
          next.hand[handIdx] = null;
          if (occ.kind === 'chess') {
            next = removeTokensOf(next, occ.uid);
            const { row: _or, col: _oc, ...occBench } = occ;
            next.hand[handIdx] = occBench;
          } else {
            const ret = returnTokenToHand(next, occ, handIdx);
            if (ret.error) return ret;
            next = ret.scene;
          }
          next = { ...next, board: [...next.board, deployedPiece] };
          return grantTokensFor(sim.raw, next, deployedPiece);
        }
        const ownSummon = occ.kind === 'token' && occ.ownerUid === piece.uid;
        if (!ownSummon && !unitAllowedInScene(ctx, sim.raw, scene, occ, piece.row, piece.col).ok) {
          return { error: t('交换后的单位无法部署在原位置') };
        }
        let next = {
          ...scene,
          board: scene.board.map(p => p.uid === piece.uid ? { ...piece, row, col, dir: nextDir }
            : p.uid === occ.uid ? { ...occ, row: piece.row, col: piece.col } : p),
        };
        if (occ.kind === 'chess') {
          const liftedOcc = liftTokensOf(next, occ.uid);
          if (liftedOcc.error) return liftedOcc;
          next = liftedOcc.scene;
        }
        return liftTokensOf(next, piece.uid);
      }
      const wasOnBoard = piece.row != null;
      const deployedPiece = { ...piece, row, col, dir: nextDir };
      const next = { ...removePiece(scene, uid), board: [...scene.board.filter(p => p.uid !== uid), deployedPiece] };
      return wasOnBoard ? liftTokensOf(next, piece.uid) : grantTokensFor(sim.raw, next, deployedPiece);
    }
    case 'moveHand': {
      const idx = action.idx;
      if (!piece || (piece.kind !== 'chess' && piece.kind !== 'token') || piece.row != null || !Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) {
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
      if (piece.kind === 'token') {
        const preferred = Number.isInteger(idx) && idx >= 0 && idx < GEO.HAND_SIZE && scene.hand[idx] == null ? idx : null;
        return returnTokenToHand(removePiece(scene, uid), piece, preferred);
      }
      const occ = Number.isInteger(idx) && idx >= 0 && idx < GEO.HAND_SIZE ? scene.hand[idx] : null;
      if (occ?.kind === 'chess') {
        const ctx = scenePlacementCtx(scene, stage, sim.raw);
        if (!tileAllowsPiece(ctx, sim.raw, occ, piece.row, piece.col)) return { error: t('交换后的单位无法部署在原位置') };
        const { row: r, col: c, ...rest } = piece;
        let next = removeTokensOf(scene, piece.uid);
        const hand = next.hand.slice();
        hand[idx] = rest;
        const deployedOcc = { ...occ, row: r, col: c };
        const board = next.board.map(p => p.uid === piece.uid ? deployedOcc : p);
        next = { ...next, hand, board };
        return grantTokensFor(sim.raw, next, deployedOcc);
      }
      const { row: _row, col: _col, ...rest } = piece;
      const cleaned = removeTokensOf(removePiece(scene, uid), uid);
      return putInHand(cleaned, rest, idx);
    }
    case 'face':
      if (piece?.row != null && DIRS.includes(action.dir)) {
        const rotated = updatePiece(scene, { ...piece, dir: action.dir });
        return piece.kind === 'chess' ? liftOutOfRangeTokens(sim.raw, rotated, piece.uid) : { scene: rotated };
      }
      break;
    case 'configure': {
      if (piece?.kind !== 'chess') return { error: t('找不到该单位') };
      const baseRec = sim.raw.chess[piece.id];
      if (!baseRec) return { error: t('找不到该单位') };
      const golden = Boolean(piece.golden || baseRec.isGolden);
      if (action.reset) {
        const next = { ...piece };
        delete next.skillIndex;
        delete next.moduleId;
        delete next.potential;
        delete next.cultivate;
        delete next.skin;
        if (baseRec.isDiy && piece.diy?.charId) {
          const defPick = defaultDiyPick(sim.raw, piece.id, piece.diy.charId);
          if (defPick) next.diy = defPick;
        }
        return reconcileTokensFor(sim.raw, updatePiece(scene, next), next);
      }
      const next = { ...piece };
      if (baseRec.isDiy) {
        const slot = diySlot(piece.id, sim.raw);
        if (!slot || !piece.diy?.charId) return { error: t('找不到该单位') };
        const isProto = isPrototypePick(sim.raw, slot.tier, piece.diy.charId);
        if ('skillIndex' in action || 'moduleId' in action) {
          if (isProto) return { error: t('无效的调配选项') };
          const wantSkill = 'skillIndex' in action ? action.skillIndex : piece.diy.skillIndex;
          let wantMod = piece.diy.uniEquipId ?? null;
          if ('moduleId' in action) {
            if (!golden) return { error: t('无效的调配选项') };
            wantMod = action.moduleId === MODULE_NONE || !action.moduleId ? null : action.moduleId;
            if (wantMod !== null) {
              const modRec = diyModuleOf(piece.id, piece.diy.charId, wantMod, sim.raw);
              if (!isDiyModule(modRec)) return { error: t('无效的调配选项') };
            }
          }
          const checked = checkDiyPick(piece.id, { charId: piece.diy.charId, skillIndex: wantSkill, uniEquipId: wantMod }, sim.raw);
          if (!('ok' in checked)) return { error: t('无效的调配选项') };
          next.diy = checked.pick;
        }
        if ('potential' in action) {
          const pot = action.potential;
          if (isProto || !isPotential(pot) || (pot !== POTENTIAL_DEFAULT && !charPotentialChanges(sim.raw, piece.diy.charId))) {
            return { error: t('无效的调配选项') };
          }
          if (pot === POTENTIAL_DEFAULT) delete next.potential;
          else next.potential = pot;
        }
        if ('cultivate' in action) {
          if (isProto || !isCultivate(action.cultivate)) return { error: t('无效的调配选项') };
          if (action.cultivate === CULTIVATE_DEFAULT) delete next.cultivate;
          else next.cultivate = action.cultivate;
        }
      } else {
        const baseId = baseRec.baseId || piece.id;
        const normalRec = sim.raw.chess[baseId] || baseRec;
        const goldenRec = normalRec.goldenId ? sim.raw.chess[normalRec.goldenId] || null : (golden ? baseRec : null);
        const opt = loadoutOptions(normalRec, goldenRec);
        if ('skillIndex' in action) {
          const sk = action.skillIndex;
          if (!opt.skills.includes(sk)) return { error: t('无效的调配选项') };
          if (sk === opt.defaultSkill) delete next.skillIndex;
          else next.skillIndex = sk;
        }
        if ('moduleId' in action) {
          if (!golden || !opt.modules.includes(action.moduleId)) return { error: t('无效的调配选项') };
          if (action.moduleId === opt.defaultModule) delete next.moduleId;
          else next.moduleId = action.moduleId;
        }
        if ('potential' in action) {
          const pot = action.potential;
          if (!isPotential(pot) || (pot !== POTENTIAL_DEFAULT && !charPotentialChanges(sim.raw, normalRec.charId))) {
            return { error: t('无效的调配选项') };
          }
          if (pot === POTENTIAL_DEFAULT) delete next.potential;
          else next.potential = pot;
        }
        if ('cultivate' in action) {
          if (!isCultivate(action.cultivate)) return { error: t('无效的调配选项') };
          if (action.cultivate === CULTIVATE_DEFAULT) delete next.cultivate;
          else next.cultivate = action.cultivate;
        }
      }
      if ('skin' in action) {
        const skin = typeof action.skin === 'string' && action.skin.trim() ? action.skin.trim() : null;
        if (skin) next.skin = skin;
        else delete next.skin;
      }
      return reconcileTokensFor(sim.raw, updatePiece(scene, next), next);
    }
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
    case 'setBossSide': {
      if (scene.fieldMode !== 'boss') return { error: t('当前不是 Boss 战场景') };
      const nextSide = action.side === 'R' ? 'R' : 'L';
      if (nextSide === bossSideOf(scene)) return { scene };
      return { scene: { ...scene, bossSide: nextSide } };
    }
    case 'setBondLayers': {
      const bond = sim.raw.bonds?.[action.bondId];
      if (!bond) return { error: t('找不到该盟约') };
      if (bond.noStack) return { error: t('该盟约不支持修改层数') };
      const nextLayers = clampBondLayers(action.layers);
      return { scene: { ...scene, bondLayers: { ...(scene.bondLayers || {}), [action.bondId]: nextLayers } } };
    }
    case 'remove': {
      if (piece?.kind === 'token') return { error: t('无法放置在该位置') };
      const cleaned = piece?.kind === 'chess' ? removeTokensOf(removePiece(scene, uid), uid) : removePiece(scene, uid);
      return { scene: { ...cleaned, enemies: cleaned.enemies.filter(p => p.uid !== uid) } };
    }
  }
  return { error: t('找不到该单位') };
}
