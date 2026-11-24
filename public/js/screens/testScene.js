import { render } from '../../vendor/preact.module.js';
import { useCallback, useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { BOND_LAYER_CAP, GEO } from '../../../shared/constants.js';
import { unitStatsEntry } from '../../../shared/protocol.js';
import { diyRecord } from '../../../shared/diy.js';
import { DEFAULT_VERSION, LOBBY_DEFAULT_VERSION, VERSIONS, versionById } from '../../../shared/versions.js';
import { t } from '../../../shared/i18n.js';
import { data, useData } from '../data.js';
import { audio } from '../audio.js';
import { storedLobbyVersion } from '../versions.js';
import { loadBrowserSim, SIM_DATA_FILES } from '../battle/simLoader.js';
import { makeRunner } from '../battle/localPlayback.js';
import {
  BATTLE_CAP, bossSideOf, canPlaceInScene, chessRecordOf, clampBondLayers, defaultStageOf, editScene, emptyScene,
  equipNeedsReplace, hasCombatants, legalTilesFor, prepViewState, sceneEquipment, sceneOperators,
  sceneSpec, sceneStages, sceneTerrain, stageBosses, stageCoordOf,
} from '../battle/testSceneModel.js';
import { Button, html, Icon } from '../ui/components.js';
import { BossRouteToggle } from '../ui/bossRouteToggle.js';
import { BondGlyph, Img } from '../ui/gameComponents.js';
import { ToastHost, toast } from '../ui/toasts.js';
import { chessAvatarUrl, enemyIconUrl, itemIconUrl } from '../ui/assetUrls.js';
import { mountFieldView } from '../ui/fieldHost.js';
import { FacingWheel, holdPiece, setPieceDir, showRange, syncPieceDirs, useTileScreen } from '../ui/facingWheel.js';
import { Underframe, underframeRect, TempRowNotice } from '../ui/underframe.js';
import { DetailPanel, resolveDetail } from '../ui/detailPanel.js';
import { BondStrip, BondPopup } from '../ui/bondStrip.js';
import { EquipReplaceDialog, replaceRequest } from '../ui/equipReplace.js';
import { previewGrid, previewRecord, pieceDir } from '../ui/facing.js';
import { isHealingRange, rangeStyle } from '../ui/rangeStyle.js';
import { pieceTile } from '../render/drag.js';
import {
  closesOnFieldPress, deviceInfo, indexPieces, panelSide, panelSlots, shortcutFor, terrainInfo,
} from '../ui/gameLogic.js';
import { settingsStore } from '../ui/settings.js';
import { installDeviceSupport } from '../ui/device.js';
import { initLang, useLang } from '../ui/lang.js';
import { SEL_RANGE } from './game/marks.js';
import { inspectRange } from './game/range.js';

const FILES = { chess: 'chess', item: 'items', enemy: 'enemies' };
const ICONS = { chess: 'user', item: 'shield', enemy: 'sword' };
const LAYER_PRESETS = [0, 20, 50, 100, 200, 500, BOND_LAYER_CAP];
const TEST_SCENE_HUD = () => ({ top: 100, bottom: 18 });
const TEST_SCENE_PADDING = () => ({ top: 100, bottom: 24, left: 20, right: 20 });
const VERSION_OPTIONS = [
  ...VERSIONS.filter(v => v.id === LOBBY_DEFAULT_VERSION),
  ...VERSIONS.filter(v => v.id !== LOBBY_DEFAULT_VERSION),
];

function initialVersionId() {
  try {
    const q = new URLSearchParams(window.location.search).get('version');
    if (q && versionById(q)) return q;
  } catch { /* ignore */ }
  return storedLobbyVersion() || LOBBY_DEFAULT_VERSION;
}

function recordOf({ id, kind, diy }) {
  if (kind === 'chess') {
    const chess = data.lookup('chess', id);
    if (diy && chess?.isDiy) {
      return diyRecord(id, diy, { data: { chess: data.get('chess'), backups: data.get('backups') } }) || chess;
    }
    return chess;
  }
  return data.lookup(FILES[kind], id);
}

const nameOf = piece => recordOf(piece)?.name || piece?.diy?.charId || piece?.id;
const pieceLookups = (base, raw, piece) => (piece?.diy
  ? { ...base, getChess: id => (id === piece.id ? chessRecordOf(raw, piece) : base.getChess(id)) }
  : base);

function mapValueOf(stageId, fieldMode) {
  return fieldMode === 'boss' ? `${stageId}:boss` : stageId;
}

function parseMapValue(val) {
  if (typeof val === 'string' && val.endsWith(':boss')) return { stageId: val.slice(0, -5), fieldMode: 'boss' };
  return { stageId: val, fieldMode: 'normal' };
}

function Portrait({ kind, id, diy }) {
  const rec = recordOf({ kind, id, diy });
  const assets = data.get('assets');
  const src = kind === 'chess' ? chessAvatarUrl(assets, rec) : kind === 'item' ? itemIconUrl(assets, rec) : enemyIconUrl(assets, id);
  return html`<span class="ts-portrait" aria-hidden="true">
    <${Img} src=${src} fallback=${html`<${Icon} name=${ICONS[kind]} />`} />
  </span>`;
}

function BossPicker({ bossInfo, selectedBossId, onSelectMode, onSelectBoss }) {
  const bossesLoc = data.get('bosses');
  const enemiesLoc = data.get('enemies');
  const assets = data.get('assets');
  const picked = bossInfo.bosses.find(b => b.bossId === selectedBossId) || null;
  const formatHp = n => Number(n || 0).toLocaleString();
  return html`<div class="ts-boss-panel" data-testid="test-scene-boss-panel">
    <label class="ts-boss-mode">
      <span>${t('难度')}</span>
      <select data-testid="test-scene-boss-mode" value=${bossInfo.modeId || ''}
        onChange=${e => onSelectMode(e.currentTarget.value)}>
        ${bossInfo.modes.map(m => html`<option key=${m.modeId} value=${m.modeId}>${m.name}</option>`)}
      </select>
    </label>
    <p class="ts-boss-note">${t('Boss 战场景禁止自定义摆放普通敌人，选择本图可选 Boss 后按实战波次与路线生成。')}</p>
    <ul class="ts-catalogue__list ts-boss-list" aria-label=${t('可选 Boss')}>
      ${bossInfo.bosses.map(b => {
        const label = bossesLoc?.[b.bossId]?.name || b.name;
        const active = b.bossId === selectedBossId;
        return html`<li key=${b.bossId}>
          <button type="button" class="ts-pick ts-boss-pick" data-boss=${b.bossId}
            aria-pressed=${active} title=${label}
            onClick=${() => onSelectBoss(active ? null : b.bossId)}>
            <span class="ts-portrait" aria-hidden="true">
              <${Img} src=${enemyIconUrl(assets, b.enemyKey)} fallback=${html`<${Icon} name="skull" />`} />
            </span>
            <span class="ts-boss-pick__main">
              <strong class="ts-boss-pick__name">${label}</strong>
              <small class="ts-boss-pick__hp num">HP ${formatHp(b.poolHp)}</small>
            </span>
            <span class="ts-pick__tags">
              <small class=${b.hidden ? 'ts-tag--hidden' : 'ts-tag--boss'}>${b.hidden ? t('隐秘核心') : t('最终攻势')}</small>
            </span>
            <${Icon} name=${active ? 'check' : 'chevronRight'} />
          </button>
        </li>`;
      })}
      ${bossInfo.bosses.length ? null : html`<li class="ts-muted">${t('没有匹配项')}</li>`}
    </ul>
    ${picked ? html`<div class="ts-boss-summary" data-testid="test-scene-boss-summary">
      <div class="ts-boss-summary__head">
        <strong>${bossesLoc?.[picked.bossId]?.name || picked.name}</strong>
        <span class="num">${t('第 {round} 回合', { round: picked.round })}</span>
      </div>
      <div class="ts-boss-summary__hp">
        <span>${t('领袖生命值池')}</span>
        <strong class="num">${formatHp(picked.poolHp)}</strong>
      </div>
      ${picked.escorts.length ? html`<div class="ts-boss-summary__escorts">
        <span class="ts-boss-summary__label">${t('实战随行配置')}</span>
        <ul>
          ${picked.escorts.map(e => html`<li key=${`${e.isPart ? 'p' : 'e'}:${e.key}`}>
            <span>${enemiesLoc?.[e.key]?.name || e.key}${e.isPart ? ` (${t('部位')})` : ''}</span>
            <strong class="num">×${e.count}</strong>
          </li>`)}
        </ul>
      </div>` : null}
    </div>` : null}
  </div>`;
}

function Catalogue({ raw, scene, bossInfo, armed, onPick, onSelectBossMode, onSelectBoss }) {
  const lang = useLang();
  const [kind, setKind] = useState('chess');
  const [query, setQuery] = useState('');
  const isBossField = scene.fieldMode === 'boss';
  const file = FILES[kind];
  const localized = data.get(file);
  const backups = data.get('backups');
  const rows = useMemo(() => {
    if (isBossField && kind === 'enemy') return [];
    if (kind === 'chess') {
      return sceneOperators(raw)
        .map(op => ({
          key: op.key, id: op.id, diy: op.diy, charId: op.charId,
          name: nameOf({ id: op.id, kind: 'chess', diy: op.diy }),
          original: op.rec.name, golden: op.golden, isDiy: op.isDiy,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, lang) || a.key.localeCompare(b.key));
    }
    return Object.entries(raw[file])
      .filter(([, rec]) => kind === 'item' ? sceneEquipment(rec) : true)
      .map(([id, rec]) => ({ key: id, id, diy: null, charId: null, name: nameOf({ id, kind }), original: rec.name, golden: rec.isGolden, isDiy: false }))
      .sort((a, b) => a.name.localeCompare(b.name, lang) || a.id.localeCompare(b.id));
  }, [kind, raw, file, localized, backups, lang, isBossField]);
  const q = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => [row.name, row.original, row.id, row.charId].some(text => text?.toLocaleLowerCase().includes(q)));
  return html`<aside class="ts-catalogue" data-testid="test-scene-catalogue">
    <div class="ts-kinds" role="group" aria-label=${t('选择类型')}>
      ${[['chess', t('干员')], ['item', t('装备')], ['enemy', isBossField ? t('Boss') : t('敌人')]].map(([key, label]) => html`
        <button type="button" key=${key} aria-pressed=${kind === key} data-kind=${key} onClick=${() => { setKind(key); setQuery(''); }}>${label}</button>`)}
    </div>
    ${isBossField && kind === 'enemy' ? html`
      <${BossPicker} bossInfo=${bossInfo} selectedBossId=${scene.bossId}
        onSelectMode=${onSelectBossMode} onSelectBoss=${onSelectBoss} />
    ` : html`
      <input class="ts-search" type="search" value=${query} aria-label=${t('搜索名称或 ID')} placeholder=${t('搜索名称或 ID')}
        onInput=${event => setQuery(event.currentTarget.value)} />
      <ul class="ts-catalogue__list" aria-label=${t('搜索结果')}>
        ${filtered.map(({ key, id, diy, charId, name, golden, isDiy }) => html`<li key=${key}>
          <button type="button" class="ts-pick" data-record=${key} data-char=${charId} title=${name} aria-pressed=${kind === 'enemy' ? armed === id : undefined}
            onClick=${() => onPick(kind, id, diy)}>
            <${Portrait} kind=${kind} id=${id} diy=${diy} />
            <span>${name}</span>
            <span class="ts-pick__tags">
              ${isDiy ? html`<small class="ts-tag--diy">${t('自选')}</small>` : null}
              ${golden ? html`<small class="ts-tag--golden">${t('精锐')}</small>` : null}
            </span>
            <${Icon} name=${kind === 'enemy' ? 'chevronRight' : 'plus'} />
          </button>
        </li>`)}
        ${filtered.length ? null : html`<li class="ts-muted">${t('没有匹配项')}</li>`}
      </ul>
    `}
  </aside>`;
}

function BondLayerDialog({ bondId, initialLayers, onConfirm, onCancel }) {
  const [val, setVal] = useState(String(initialLayers ?? 0));
  const inputRef = useRef(null);
  const bond = data.lookup('bonds', bondId);
  const name = bond?.name || bondId;
  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, [bondId]);
  const submit = e => {
    e?.preventDefault?.();
    onConfirm(bondId, clampBondLayers(val));
  };
  return html`<div class="ts-layer-backdrop" onClick=${onCancel}>
    <form class="ts-layer-modal" data-testid="test-scene-layer-modal" role="dialog" aria-modal="true"
      aria-label=${t('修改盟约层数：{name}', { name })}
      onClick=${e => e.stopPropagation()} onSubmit=${submit}>
      <header class="ts-layer-modal__head">
        <span class="ts-layer-modal__disc"><${BondGlyph} bondId=${bondId} /></span>
        <div>
          <h3>${name}</h3>
          <p>${t('输入盟约层数（0 - {max}）', { max: BOND_LAYER_CAP })}</p>
        </div>
        <button type="button" class="ts-layer-modal__close" aria-label=${t('关闭')} onClick=${onCancel}><${Icon} name="close" /></button>
      </header>
      <div class="ts-layer-modal__field">
        <input ref=${inputRef} data-testid="test-scene-layer-input" type="number" min="0" max=${BOND_LAYER_CAP} step="1"
          value=${val} onInput=${e => setVal(e.currentTarget.value)} />
      </div>
      <div class="ts-layer-modal__presets">
        ${LAYER_PRESETS.map(n => html`<button type="button" key=${n} class=${Number(val) === n ? 'is-on' : ''}
          onClick=${() => setVal(String(n))}>${n}</button>`)}
      </div>
      <footer class="ts-layer-modal__foot">
        <${Button} variant="ghost" onClick=${onCancel}>${t('取消')}<//>
        <${Button} variant="primary" type="submit" data-testid="test-scene-layer-confirm">${t('确定')}<//>
      </footer>
    </form>
  </div>`;
}

function TestScene() {
  const lang = useLang();
  useData('stages', 'chess', 'enemies', 'items', 'backups', 'bonds', 'effects', 'garrisons', 'tokens', 'bosses', 'assets', 'local');
  const hostRef = useRef(null);
  const hudElRef = useRef(null);
  const pageRef = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [versionId, setVersionId] = useState(initialVersionId);
  const [content, setContent] = useState(null);
  const [bootError, setBootError] = useState(false);
  const [viewState, setViewState] = useState({ view: null, kind: 'loading' });
  const [scene, setScene] = useState(emptyScene);
  const [armed, setArmed] = useState(null);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [bondOpen, setBondOpen] = useState(null);
  const [layerEditor, setLayerEditor] = useState(null);
  const [dragUid, setDragUid] = useState(null);
  const [facing, setFacing] = useState(null);
  const [holdSeq, setHoldSeq] = useState(0);
  const [replace, setReplace] = useState(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState(null);
  const [bossRouteVisible, setBossRouteVisible] = useState(true);
  const [finished, setFinished] = useState(false);
  const [battleStatus, setBattleStatus] = useState(null);
  const [battleMeta, setBattleMeta] = useState(null);

  const stageAppliedRef = useRef(null);
  const modeRef = useRef('init');
  const ptrRef = useRef({ tile: null, released: false });
  const pressSel = useRef(null);
  const battleRef = useRef(null);
  const snapUnitsRef = useRef(new Map());
  const replaceRef = useRef(null);
  replaceRef.current = replace;

  useEffect(() => { document.title = t('测试场景'); }, [lang]);

  useEffect(() => {
    let active = true;
    const files = [...SIM_DATA_FILES, 'config', 'bosses'];
    const entry = versionById(versionId) || versionById(DEFAULT_VERSION);
    setBootError(false);
    setContent(null);
    stageAppliedRef.current = null;
    if (attempt > 0) for (const name of ['assets', 'local']) if (data.status(name) === 'missing') data.invalidate(name);
    (async () => {
      let sim, config, bosses;
      if (!entry || entry.id === DEFAULT_VERSION || !entry.dir) {
        data.setContent(null);
        const values = await Promise.all(files.map(name => data.status(name) === 'missing' ? data.invalidate(name) : data.load(name)));
        if (values.some(value => !value)) throw new Error('test-scene data unavailable');
        sim = await loadBrowserSim({ reuse: name => data.getRaw(name), reuseOwner: () => data.contentId() });
        config = data.getRaw('config');
        bosses = data.getRaw('bosses');
      } else {
        const prefix = `/data/${entry.dir}`;
        const loaded = {};
        await Promise.all(files.map(async name => {
          const res = await fetch(`${prefix}${name}.json`, { cache: 'no-cache' });
          if (!res.ok) throw new Error(`test-scene version data unavailable: ${name}`);
          loaded[name] = await res.json();
        }));
        data.setContent({ id: entry.id, values: loaded });
        sim = await loadBrowserSim({ data: loaded });
        config = loaded.config;
        bosses = loaded.bosses;
      }
      const { buildBossRoutePreview } = await import('/sim/bossRoutePreview.js');
      const stages = sceneStages(sim.raw.stages);
      if (!stages.length) throw new Error('default test-scene stage unavailable');
      const startStage = defaultStageOf(stages);
      if (active) {
        setScene(emptyScene(startStage, 'normal'));
        setArmed(null);
        setSel(null);
        setDetail(null);
        setBondOpen(null);
        setLayerEditor(null);
        setRun(null);
        setFinished(false);
        setError('');
        setContent({ versionId: entry?.id || DEFAULT_VERSION, sim, stages, config, bosses, buildBossRoutePreview });
      }
    })().catch(() => { if (active) setBootError(true); });
    return () => { active = false; };
  }, [attempt, versionId]);

  const stage = content?.sim.raw.stages[scene.stageId];
  const bossSide = bossSideOf(scene);
  const terrain = useMemo(() => (content && content.sim.raw.stages[scene.stageId]
    ? sceneTerrain(content.sim, scene.stageId, scene.fieldMode, bossSide)
    : null), [content, scene.stageId, scene.fieldMode, bossSide]);
  const bossInfo = useMemo(() => (content && scene.fieldMode === 'boss'
    ? stageBosses(content.sim.raw, content.config, content.bosses, scene.stageId, scene.bossModeId, bossSide)
    : { modeId: null, difficulty: null, modes: [], bosses: [] }), [content, scene.fieldMode, scene.stageId, scene.bossModeId, bossSide]);
  const lookups = useMemo(() => content && ({
    getChess: id => content.sim.raw.chess[id],
    getToken: id => content.sim.raw.tokens[id],
    getItem: id => content.sim.raw.items[id],
  }), [content]);
  const view = viewState.view;
  const { stageId, fieldMode, bossId, bossModeId } = scene;
  const bossPreview = useMemo(() => {
    if (content?.versionId !== versionId || fieldMode !== 'boss' || !bossId) return null;
    const { sim, buildBossRoutePreview } = content;
    const previewScene = { ...emptyScene(stageId, 'boss', { bossModeId, bossId, bossSide }) };
    const spec = sceneSpec(sim, previewScene, null, content);
    const leader = spec.spawns.find(spawn => spawn.tag === 'boss');
    if (!leader) return null;
    const start = spec.routes[leader.routeIndex]?.start;
    return {
      route: buildBossRoutePreview({ ...spec, side: bossSide }, sim.ds),
      // The renderer already uses the upcoming leader's spawn tile for its prep standee and hit tiles.
      nextEnemies: [{ enemyKey: leader.enemyKey, count: 1, boss: true, tag: 'boss', start }],
    };
  }, [content, versionId, stageId, fieldMode, bossId, bossModeId, bossSide]);

  const prepPriv = useMemo(() => ({
    ...prepViewState(scene, nameOf, content?.sim?.raw || null),
    ...(bossPreview ? { nextEnemies: bossPreview.nextEnemies } : null),
  }), [scene, content, lang, bossPreview]);
  const displayBonds = useMemo(() => {
    const base = prepPriv.bonds || [];
    const live = battleStatus?.bondLayers;
    if (!run || !live) return base;
    return base.map(b => (live[b.bondId] != null ? { ...b, layers: live[b.bondId] } : b));
  }, [prepPriv.bonds, run, battleStatus?.bondLayers]);
  const displayPriv = useMemo(() => (displayBonds === prepPriv.bonds ? prepPriv : { ...prepPriv, bonds: displayBonds }), [prepPriv, displayBonds]);
  const pieces = useMemo(() => indexPieces(prepPriv), [prepPriv]);
  const selPieceEntry = sel?.kind === 'piece' ? pieces.get(sel.uid) || null : null;
  const selEnemy = sel?.kind === 'enemy' ? scene.enemies.find(e => e.uid === sel.uid) || null : null;

  const refuse = useCallback(reason => {
    if (!reason) return;
    setError(reason);
    toast(reason, 'warn');
    audio.sfx('error', { volume: 0.5 });
  }, []);

  const closeReplace = useCallback(uid => {
    const cur = replaceRef.current;
    if (!cur) return;
    replaceRef.current = null;
    setReplace(null);
    try { cur.resolve(Number.isInteger(uid) ? uid : null); } catch { /* ignore */ }
  }, []);

  const openReplace = useCallback(request => new Promise(resolve => {
    if (replaceRef.current) { try { replaceRef.current.resolve(null); } catch { /* ignore */ } }
    const next = { request, resolve };
    replaceRef.current = next;
    setSel(null);
    setReplace(next);
    audio.sfx('click', { volume: 0.5 });
  }), []);

  useEffect(() => () => {
    const cur = replaceRef.current;
    replaceRef.current = null;
    try { cur?.resolve(null); } catch { /* ignore */ }
  }, []);

  // Mount one live field renderer (Pixi 3D/2D or DOM fallback) for both editing and combat.
  useEffect(() => {
    if (!content || !hostRef.current) return undefined;
    const host = hostRef.current;
    const controller = new AbortController();
    let mounted = null;
    const onResize = () => mounted?.resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(host);
    const dispose = () => {
      controller.abort();
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', dispose);
      mounted?.destroy();
      mounted = null;
      stageAppliedRef.current = null;
      modeRef.current = 'init';
      setViewState({ view: null, kind: 'loading' });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', dispose);
    mountFieldView(host, { signal: controller.signal, hud: TEST_SCENE_HUD, padding: TEST_SCENE_PADDING }).then(field => {
      if (controller.signal.aborted) { field.destroy(); return; }
      mounted = field;
      setViewState({ view: field, kind: field.kind });
    }).catch(err => {
      if (!controller.signal.aborted) {
        console.warn('[test scene] field view failed:', err);
        setError(t('战斗载入失败，请重试'));
      }
    });
    return dispose;
  }, [content]);

  const live = useRef({});
  const edit = useCallback(action => {
    const L = live.current;
    if (!L.content || !L.terrain) return false;
    const result = editScene(L.scene, action, { ...L.content, terrain: L.terrain });
    if (result.error) { refuse(result.error); return false; }
    setError('');
    setScene(result.scene);
    if (action.type === 'remove') {
      setSel(s => s?.uid === action.uid ? null : s);
      setDetail(d => ((d?.kind === 'piece' && d.uid === action.uid) || (d?.kind === 'enemy' && d.uid === action.uid)) ? null : d);
    }
    return true;
  }, [refuse]);

  const cancelFacing = useCallback(() => {
    const f = live.current.facing;
    if (!f) return;
    setFacing(null);
    if (live.current.view) {
      if (f.piece.kind !== 'item') setPieceDir(live.current.view, f.uid, pieceDir(f.piece));
      holdPiece(live.current.view, f.uid, null);
    }
    setHoldSeq(n => n + 1);
    audio.sfx('back', { volume: 0.5 });
  }, []);

  const previewFacing = useCallback(dir => {
    const f = live.current.facing;
    if (!f || !live.current.view || f.piece.kind === 'item') return;
    setPieceDir(live.current.view, f.uid, dir || pieceDir(f.piece));
  }, []);

  const commitFacing = useCallback(dir => {
    const f = live.current.facing;
    if (!f) return;
    setFacing(null);
    if (live.current.view) holdPiece(live.current.view, f.uid, null);
    const ok = edit({ type: 'deploy', uid: f.uid, row: f.row, col: f.col, dir });
    if (!ok) {
      if (live.current.view && f.piece.kind !== 'item') setPieceDir(live.current.view, f.uid, pieceDir(f.piece));
      setHoldSeq(n => n + 1);
    }
  }, [edit]);

  const equipOrReplace = useCallback(async (itemUid, targetUid) => {
    const L = live.current;
    if (!L.content || !L.terrain) return;
    const ctx = { ...L.content, terrain: L.terrain };
    if (equipNeedsReplace(L.scene, itemUid, targetUid, ctx)) {
      const targetPiece = L.pieces.get(targetUid)?.piece;
      const shown = id => {
        if (targetPiece && id === targetPiece.id && targetPiece.diy) {
          return recordOf(targetPiece);
        }
        return data.lookup('chess', id);
      };
      const req = replaceRequest(
        { pieces: L.pieces, getChess: shown, equipPerChess: L.content.config.economy?.equipPerChess, morphMode: 'official' },
        { t: 'g.equip', fields: { itemUid, targetUid }, confirmReplace: true },
        shown,
        id => data.lookup('items', id),
      );
      if (req) {
        const replaceUid = await openReplace(req);
        if (!Number.isInteger(replaceUid)) { audio.sfx('back', { volume: 0.5 }); return; }
        edit({ type: 'equip', uid: itemUid, target: targetUid, replaceUid });
        return;
      }
    }
    edit({ type: 'equip', uid: itemUid, target: targetUid });
  }, [edit, openReplace]);

  live.current = {
    content, terrain, scene, prepPriv, pieces, armed, sel, detail, bondOpen, layerEditor, run, facing, dragUid, lookups,
    view, edit, cancelFacing, equipOrReplace, refuse,
  };

  // Sync prep scene (operators, equipment area, bench pads, placed enemies) into the live renderer.
  useEffect(() => {
    if (!view || !content || !stage || run) return;
    const stageKey = `${scene.stageId}:${scene.fieldMode}:${bossSide}`;
    const stageChanged = stageAppliedRef.current !== stageKey;
    if (stageChanged) {
      view.setStage(stage);
      stageAppliedRef.current = stageKey;
    }
    const enteringPrep = modeRef.current !== 'prep';
    modeRef.current = 'prep';
    view.setPrep(prepPriv, {
      editable: true,
      canPlace: (uid, target) => canPlaceInScene(live.current.scene, uid, target, { ...live.current.content, terrain: live.current.terrain }),
    });
    if (enteringPrep || stageChanged) {
      if (scene.fieldMode === 'boss') view.setCamera('bossPrep', { side: bossSide, shop: false, instant: true });
      else view.setCamera('prep', { shop: false, instant: true });
    }
    syncPieceDirs(view, prepPriv, live.current.facing?.uid ?? null);
  }, [view, content, stage, scene, bossSide, prepPriv, run, holdSeq]);

  useEffect(() => {
    view?.setBossRoute?.(!run && bossRouteVisible ? bossPreview?.route : null);
  }, [view, stage, run, bossSide, bossPreview, bossRouteVisible]);

  // Clear stale selection/detail when a piece disappears or combat starts.
  useEffect(() => {
    if (run) { setSel(null); setArmed(null); setLayerEditor(null); }
  }, [run]);
  useEffect(() => {
    if (sel?.kind === 'piece' && !selPieceEntry) setSel(null);
    if (sel?.kind === 'enemy' && !selEnemy) setSel(null);
  }, [sel, selPieceEntry, selEnemy]);

  // Resolve official DetailPanel data (supports standard & DIY pieces, items, placed enemies, battle units, terrain & devices).
  const detailTarget = useMemo(() => {
    if (!detail) return null;
    if (detail.kind === 'unit' && battleMeta) {
      const id = detail.unitId ?? detail.unit?.id;
      const u = (Array.isArray(battleMeta.units) ? battleMeta.units : []).find(x => x && x.id === id);
      return u ? { ...detail, unit: u } : detail;
    }
    return detail;
  }, [detail, battleMeta]);

  const resolved = useMemo(() => resolveDetail(detailTarget, pieces, {
    priv: displayPriv,
    backups: data.get('backups'),
  }), [detailTarget, pieces, displayPriv, lang]);

  useEffect(() => {
    if (detail && !resolved && detail.kind === 'piece') setDetail(null);
  }, [detail, resolved]);

  // Live stats & HP during combat for DetailPanel.
  const snapHp = (() => {
    if (!run || !resolved) return null;
    const id = resolved.unitId;
    const tup = id != null ? snapUnitsRef.current.get(id) : null;
    return tup ? { hp: tup[3], max: tup[4] } : null;
  })();

  const liveStats = useMemo(() => {
    if (!run || !resolved) return null;
    const id = resolved.unitId;
    const pieceUid = id == null && Number.isInteger(resolved.piece?.uid) ? resolved.piece.uid : null;
    if (id == null && pieceUid == null) return null;
    return () => {
      const battle = battleRef.current;
      if (!battle) return null;
      const u = id != null
        ? battle.units.find(x => x && x.id === id)
        : battle.units.find(x => x && x.uid === pieceUid);
      if (!u) return null;
      try { return { ...unitStatsEntry(u, u._s || null), src: 'battle' }; } catch { return null; }
    };
  }, [run, resolved]);

  // Highlight legal tiles (during drag or armed enemy placement) or inspected unit attack range (via inspectRange).
  const cardRange = useMemo(() => {
    if (dragUid != null || facing || armed) return null;
    const pieceForRange = detailTarget?.kind === 'piece' ? pieces.get(detailTarget.uid)?.piece : null;
    const getChess = id => (pieceForRange && id === pieceForRange.id && pieceForRange.diy
      ? chessRecordOf(content?.sim?.raw, pieceForRange)
      : data.lookup('chess', id));
    return inspectRange({
      target: detailTarget,
      detail: resolved,
      pieces,
      showPrep: !run,
      field: battleMeta,
      snapshot: snapUnitsRef.current.get(resolved?.unitId),
      live: typeof liveStats === 'function' ? liveStats() : liveStats,
      loadout: null,
      getChess,
      backups: data.get('backups'),
    });
  }, [dragUid, facing, armed, detailTarget, resolved, pieces, run, battleMeta, liveStats, content, battleStatus?.time]);

  const cardRangeKey = cardRange ? JSON.stringify(cardRange) : '';

  useEffect(() => {
    if (!view || !content || !terrain) return undefined;
    if (facing) return undefined;
    if (!run) {
      view.highlightTiles(null, null);
      const ctx = { ...content, terrain };
      if (dragUid != null) {
        view.highlightTiles(legalTilesFor(scene, { uid: dragUid }, ctx), 'legal');
        return undefined;
      }
      if (armed && scene.fieldMode !== 'boss') {
        view.highlightTiles(legalTilesFor(scene, { enemy: armed }, ctx), 'legal');
        return undefined;
      }
    }
    if (cardRange) {
      showRange(view, cardRange.grid, cardRange.row, cardRange.col, cardRange.dir, rangeStyle(SEL_RANGE, cardRange.healing));
      return () => showRange(view, null, 0, 0, null, SEL_RANGE);
    }
    showRange(view, null, 0, 0, null, SEL_RANGE);
    return undefined;
  }, [view, content, terrain, scene, run, facing, dragUid, armed, cardRangeKey]);

  // Pressing on the field clears selection and field-opened detail (re-selected at pieceClick release, identical to game.js).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onDown = () => {
      const L = live.current;
      if (L.armed) return;
      pressSel.current = L.sel ? L.sel.uid : null;
      if (L.sel) setSel(null);
      setDetail(d => (closesOnFieldPress(d) ? null : d));
    };
    host.addEventListener('pointerdown', onDown, true);
    return () => host.removeEventListener('pointerdown', onDown, true);
  }, []);

  // Dismiss DetailPanel / Underframe / BondPopup on outside clicks inside the page (matching game.js).
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return undefined;
    const onDown = e => {
      const L = live.current;
      if (L.bondOpen && !e.target?.closest?.('.bpop, .bslot, .dpanel__bchip')) setBondOpen(null);
      if (L.detail && !e.target?.closest?.('.dpanel, .uframe, .ts-field, .ts-pick, .bpop')) setDetail(null);
      if (L.sel && !e.target?.closest?.('.uframe, .ts-field, .dpanel')) setSel(null);
    };
    root.addEventListener('pointerdown', onDown, true);
    return () => root.removeEventListener('pointerdown', onDown, true);
  }, []);

  // Wire field interactions: drag & drop, FacingWheel, Underframe selection, DetailPanel, and armed enemy placement.
  useEffect(() => {
    if (!view) return undefined;
    let moveOff = null;
    const endDrag = () => { moveOff?.(); moveOff = null; setDragUid(null); };
    const openFacing = (piece, row, col) => {
      const L = live.current;
      const resolvedLookups = pieceLookups(L.lookups, L.content.sim.raw, piece);
      view.highlightTiles(null, null);
      holdPiece(view, piece.uid, { row, col });
      setSel(null);
      setDetail(d => (d?.kind === 'piece' ? null : d));
      setFacing({
        uid: piece.uid, piece, row, col,
        grid: previewGrid(resolvedLookups, piece),
        healing: isHealingRange(previewRecord(resolvedLookups, piece)),
        name: nameOf(piece),
      });
      audio.sfx('pick', { volume: 0.5 });
    };
    const offs = [
      view.on('pieceDragStart', e => {
        const L = live.current;
        if (!e || L.run || !L.content) return;
        audio.sfx('pick', { volume: 0.6 });
        if (L.facing) L.cancelFacing();
        setArmed(null);
        setSel(null);
        setDetail(d => (d?.kind === 'piece' ? null : d));
        setError('');
        setDragUid(e.uid);
        ptrRef.current = { tile: null, released: false };
        const onUp = () => { ptrRef.current.released = true; };
        window.addEventListener('pointerup', onUp, { passive: true, capture: true });
        moveOff = () => window.removeEventListener('pointerup', onUp, { capture: true });
      }),
      view.on('tileHover', tile => { ptrRef.current.tile = tile && typeof tile === 'object' ? tile : null; }),
      view.on('pieceDrop', e => {
        endDrag();
        const L = live.current;
        if (!e || L.run || !L.content || !L.terrain) return;
        const target = e.target || {};
        if (target.area === 'outside') return;
        const entry = L.pieces.get(e.uid);
        const piece = entry?.piece;
        if (!piece) return;
        const ctx = { ...L.content, terrain: L.terrain };
        if (target.area === 'board') {
          if (piece.kind === 'item') {
            const occ = L.scene.board.find(p => p.row === target.row && p.col === target.col);
            if (!occ) { L.refuse(t('请将装备拖拽至干员身上')); return; }
            L.equipOrReplace(piece.uid, occ.uid);
            return;
          }
          if (piece.kind === 'chess') {
            const probe = editScene(L.scene, { type: 'deploy', uid: piece.uid, row: target.row, col: target.col }, ctx);
            if (probe.error) { L.refuse(probe.error); return; }
            openFacing(piece, target.row, target.col);
          }
          return;
        }
        if (target.area === 'hand') {
          const occ = L.scene.hand[target.idx];
          if (piece.kind === 'item') {
            if (occ?.kind === 'chess') L.equipOrReplace(piece.uid, occ.uid);
            else L.refuse(t('装备只能放入装备区'));
          } else if (piece.row != null) {
            L.edit({ type: 'retreat', uid: piece.uid, idx: target.idx });
          } else {
            L.edit({ type: 'moveHand', uid: piece.uid, idx: target.idx });
          }
          return;
        }
        if (target.area === 'temp') {
          if (piece.kind === 'item') L.edit({ type: 'moveTemp', uid: piece.uid, idx: target.idx });
          else L.refuse(t('装备区只能放入装备'));
        }
      }),
      view.on('pieceDragEnd', e => {
        const { released, tile } = ptrRef.current;
        endDrag();
        const L = live.current;
        if (!e || e.dropped || !released || L.run || !L.content || !L.terrain || !tile) return;
        const src = L.pieces.get(e.uid);
        if (!src) return;
        const piece = src.piece;
        const onOwnSlot = (src.area === 'board' && tile.area === 'board' && tile.row === src.row && tile.col === src.col)
          || (src.area !== 'board' && tile.area === src.area && (tile.idx ?? tile.col) === src.idx);
        if (onOwnSlot) return;
        const ctx = { ...L.content, terrain: L.terrain };
        if (tile.area === 'board' && Number.isInteger(tile.row) && Number.isInteger(tile.col)) {
          if (piece.kind === 'item') {
            const occ = L.scene.board.find(p => p.row === tile.row && p.col === tile.col);
            if (!occ) { L.refuse(t('请将装备拖拽至干员身上')); return; }
            const res = editScene(L.scene, { type: 'equip', uid: piece.uid, target: occ.uid }, ctx);
            if (res.error) L.refuse(res.error);
          } else if (piece.kind === 'chess') {
            const res = editScene(L.scene, { type: 'deploy', uid: piece.uid, row: tile.row, col: tile.col }, ctx);
            if (res.error) L.refuse(res.error);
          }
        } else if (tile.area === 'hand' && Number.isInteger(tile.idx)) {
          const occ = L.scene.hand[tile.idx];
          if (piece.kind === 'item') {
            if (occ?.kind === 'chess') {
              const res = editScene(L.scene, { type: 'equip', uid: piece.uid, target: occ.uid }, ctx);
              if (res.error) L.refuse(res.error);
            } else L.refuse(t('装备只能放入装备区'));
          } else if (piece.row != null) {
            const res = editScene(L.scene, { type: 'retreat', uid: piece.uid, idx: tile.idx }, ctx);
            if (res.error) L.refuse(res.error);
          }
        } else if (tile.area === 'temp') {
          if (piece.kind !== 'item') L.refuse(t('装备区只能放入装备'));
        } else if (Number.isInteger(tile.row) && tile.row >= GEO.FIELD.r0 && tile.row <= GEO.FIELD.r1) {
          L.refuse(piece.kind === 'item' ? t('请将装备拖拽至干员身上') : t('无法部署在该位置'));
        }
      }),
      view.on('pieceClick', e => {
        const L = live.current;
        if (!e) return;
        audio.sfx('click', { volume: 0.4 });
        if (L.run) {
          if (e.unitId != null || e.unit) {
            setDetail({ kind: 'unit', unit: e.unit || null, unitId: e.unitId, uid: e.uid });
          }
          return;
        }
        if (L.facing) return;
        if (L.armed && L.scene.fieldMode !== 'boss') {
          const boardPiece = e.prepMapChar ? L.scene.enemies.find(p => p.uid === e.uid) : L.scene.board.find(p => p.uid === e.uid);
          if (boardPiece) {
            L.edit({ type: 'enemy', id: L.armed, row: boardPiece.row, col: boardPiece.col });
            return;
          }
        }
        if (e.prepMapChar) {
          const enemyPiece = L.scene.enemies.find(p => p.uid === e.uid);
          if (!enemyPiece) return;
          setError('');
          setArmed(null);
          const wasSel = pressSel.current === enemyPiece.uid;
          pressSel.current = null;
          if (e.detail || e.button === 2) {
            setDetail({ kind: 'enemy', id: enemyPiece.id, uid: enemyPiece.uid });
          } else {
            setSel(wasSel ? null : { uid: enemyPiece.uid, kind: 'enemy' });
            setDetail(wasSel ? null : { kind: 'enemy', id: enemyPiece.id, uid: enemyPiece.uid });
          }
          return;
        }
        if (!Number.isInteger(e.uid)) return;
        const entry = L.pieces.get(e.uid);
        if (!entry) return;
        setError('');
        setArmed(null);
        setDetail({ kind: 'piece', uid: e.uid });
        if (e.detail || e.button === 2) return;
        const wasSel = pressSel.current === e.uid;
        pressSel.current = null;
        setSel(wasSel ? null : { uid: e.uid, kind: 'piece' });
        if (wasSel) setDetail(d => (d?.kind === 'piece' && d.uid === e.uid ? null : d));
      }),
      view.on('tileClick', tile => {
        const L = live.current;
        if (!tile || !Number.isInteger(tile.row) || !Number.isInteger(tile.col) || L.facing) return;
        if (!L.run && L.armed && L.scene.fieldMode !== 'boss') {
          L.edit({ type: 'enemy', id: L.armed, row: tile.row, col: tile.col });
          return;
        }
        const curStage = L.content?.sim.raw.stages[L.scene.stageId];
        if (!curStage) return;
        const [sr, sc] = L.run ? [tile.row, tile.col] : stageCoordOf(L.scene, tile.row, tile.col);
        const device = deviceInfo(curStage, sr, sc);
        if (device) {
          audio.sfx('click', { volume: 0.4 });
          setSel(null);
          setDetail({ kind: 'device', device });
          return;
        }
        const info = terrainInfo(curStage, sr, sc);
        if (info) {
          audio.sfx('click', { volume: 0.4 });
          setSel(null);
          setDetail({ kind: 'terrain', terrain: info });
        }
      }),
    ];
    return () => { endDrag(); for (const off of offs) { try { off?.(); } catch { /* ignore */ } } };
  }, [view]);

  // Keyboard shortcuts matching game.js (Q retreat, X/Delete remove, Esc dismiss).
  useEffect(() => {
    let pointer = null;
    const trackPointer = e => { pointer = e.pointerType === 'touch' ? null : { x: e.clientX, y: e.clientY, buttons: e.buttons }; };
    const clearPointer = () => { pointer = null; };
    const onKey = e => {
      const L = live.current;
      if (e.key === 'Escape' && L.layerEditor) { setLayerEditor(null); e.preventDefault(); return; }
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
      const act = shortcutFor(e, settingsStore.get().keys);
      if (act === 'escape' || e.key === 'Escape') {
        if (replaceRef.current) { closeReplace(null); e.preventDefault(); return; }
        if (L.facing) { L.cancelFacing(); e.preventDefault(); return; }
        if (L.bondOpen) { setBondOpen(null); e.preventDefault(); return; }
        if (L.armed) { setArmed(null); e.preventDefault(); return; }
        if (L.detail || L.sel) { setDetail(null); setSel(null); e.preventDefault(); return; }
        return;
      }
      if (L.run || L.dragUid != null || L.facing || L.layerEditor || replaceRef.current || pointer?.buttons) return;
      const isRemove = act === 'sell' || e.key === 'Delete' || e.key === 'Backspace';
      if (act === 'retreat' || isRemove) {
        let uid = L.sel ? L.sel.uid : null;
        if (uid == null && pointer) uid = L.view?.pieceAtClientPoint?.(pointer.x, pointer.y) ?? null;
        if (uid == null) return;
        e.preventDefault();
        if (act === 'retreat') {
          const entry = L.pieces.get(uid);
          if (entry?.area === 'board' && entry.piece.kind === 'chess') {
            if (L.edit({ type: 'retreat', uid })) {
              setSel(null);
              setDetail(d => (d?.kind === 'piece' && d.uid === uid ? null : d));
            }
          }
        } else {
          L.edit({ type: 'remove', uid });
        }
      }
    };
    for (const name of ['pointermove', 'pointerdown', 'pointerup']) window.addEventListener(name, trackPointer, true);
    window.addEventListener('blur', clearPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      for (const name of ['pointermove', 'pointerdown', 'pointerup']) window.removeEventListener(name, trackPointer, true);
      window.removeEventListener('blur', clearPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [closeReplace]);

  // Run local fixed-tick battle on the same live field renderer.
  useEffect(() => {
    if (!view || !content || !run) {
      battleRef.current = null;
      snapUnitsRef.current = new Map();
      setBattleMeta(null);
      setBattleStatus(null);
      return undefined;
    }
    let active = true, runner = null, raf = 0;
    const stopLoop = () => {
      active = false;
      cancelAnimationFrame(raf);
      runner?.pause();
      battleRef.current = null;
      view.raw.setLocalFeed?.({ on: false });
    };
    window.addEventListener('pagehide', stopLoop);
    try {
      const isBossRun = run.kind === 'boss' || run.kind === 'hidden';
      modeRef.current = 'battle';
      view.highlightTiles(null, null);
      const battle = content.sim.spec.createBattleFromSpec(run, content.sim.ds, { quiet: true });
      battleRef.current = battle;
      if (!run.spawns.length) battle.autoFinish = false;
      const runSide = isBossRun && run.players?.[0]?.side === 'R' ? 'R' : 'L';
      const runStageKey = `${run.stageId}:${isBossRun ? `boss:${runSide}` : 'normal'}`;
      if (stageAppliedRef.current !== runStageKey) {
        view.setStage(content.sim.raw.stages[run.stageId]);
        stageAppliedRef.current = runStageKey;
      }
      const meta = battle.fieldMeta();
      setBattleMeta(meta);
      view.enterBattle(meta);
      view.setCamera(isBossRun ? 'boss' : 'normal', isBossRun ? { rect: run.rect, side: runSide, half: true, instant: true } : { rect: run.rect, instant: true });
      view.raw.setLocalFeed?.({ on: true, speed: 1 });
      runner = makeRunner(battle, { cap: BATTLE_CAP, onFrame: (snap, events) => {
        if (Array.isArray(snap.units)) {
          const mp = new Map();
          for (const tup of snap.units) if (Array.isArray(tup)) mp.set(tup[0], tup);
          snapUnitsRef.current = mp;
        }
        view.pushEvents({ t: 'b.ev', fieldId: snap.fieldId, gt: snap.t, ev: events });
        view.pushSnapshot({ ...snap, t: 'b.snap', gt: snap.t });
      } });
      const publish = () => {
        if (!active) return;
        const ps = battle.getPlayer?.('test-scene');
        let bondLayers = null;
        if (ps?.bonds) {
          bondLayers = {};
          for (const [bid, st] of Object.entries(ps.bonds)) if (st && Number.isFinite(st.layers)) bondLayers[bid] = st.layers;
        }
        setBattleStatus({
          time: battle.time, kills: battle.killedInTotal, leaks: battle.leakedCount,
          total: battle.total, finished: battle.finished, reason: battle.reason, renderer: view.kind,
          bossHp: battle.sharedBoss ? Math.ceil(battle.sharedBoss.hp) : null,
          bossMaxHp: battle.sharedBoss ? Math.ceil(battle.sharedBoss.maxHp) : null,
          bondLayers,
        });
      };
      runner.play();
      publish();
      let last = performance.now(), lastStatus = last;
      const frame = now => {
        if (!active) return;
        runner.advance((now - last) / 1000);
        last = now;
        if (battle.finished || now - lastStatus >= 100) { publish(); lastStatus = now; }
        if (battle.finished) setFinished(true);
        else raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    } catch (err) {
      console.warn('[test scene] battle start failed:', err);
      stopLoop();
      setRun(null);
      setFinished(false);
      setError(t('战斗载入失败，请重试'));
    }
    return () => { window.removeEventListener('pagehide', stopLoop); stopLoop(); };
  }, [view, content, run]);

  const stop = () => {
    if (facing) cancelFacing();
    setDetail(d => (d?.kind === 'unit' ? null : d));
    setRun(null);
    setFinished(false);
    setError('');
  };

  const changeVersion = nextId => {
    if (!versionById(nextId) || nextId === versionId) return;
    stop();
    setVersionId(nextId);
  };

  const changeMap = value => {
    const { stageId, fieldMode } = parseMapValue(value);
    if (stageId === scene.stageId && fieldMode === scene.fieldMode) return;
    stop();
    const nextInfo = fieldMode === 'boss' && content
      ? stageBosses(content.sim.raw, content.config, content.bosses, stageId, null)
      : null;
    setScene(emptyScene(stageId, fieldMode, { bossModeId: nextInfo?.modeId || null, bossId: null }));
    setArmed(null);
    setSel(null);
    setDetail(null);
    setBondOpen(null);
    setLayerEditor(null);
  };

  const pick = (kind, id, diy = null) => {
    if (run) return;
    if (facing) cancelFacing();
    if (kind === 'enemy') {
      if (scene.fieldMode === 'boss') {
        refuse(t('Boss 战场景不可自定义摆放敌人，请在敌人列表中选择 Boss'));
        return;
      }
      setError('');
      setSel(null);
      setDetail(null);
      setArmed(cur => cur === id ? null : id);
    } else {
      setArmed(null);
      if (edit({ type: 'add', kind, id, ...(diy ? { diy } : null) })) audio.sfx('click', { volume: 0.4 });
    }
  };

  const selectBossMode = bossModeId => {
    if (run) return;
    if (edit({ type: 'selectBoss', bossModeId })) audio.sfx('click', { volume: 0.4 });
  };

  const selectBoss = bossId => {
    if (run) return;
    setArmed(null);
    setSel(null);
    setDetail(null);
    if (edit({ type: 'selectBoss', bossId })) audio.sfx('click', { volume: 0.4 });
  };

  const setBossSide = nextSide => {
    if (run || scene.fieldMode !== 'boss' || nextSide === bossSide) return;
    if (facing) cancelFacing();
    setArmed(null);
    setSel(null);
    setDetail(null);
    if (edit({ type: 'setBossSide', side: nextSide })) audio.sfx('click', { volume: 0.4 });
  };

  const openBond = (bondId, source = 'strip') => {
    audio.sfx('click', { volume: 0.4 });
    setBondOpen(cur => (cur?.id === bondId && cur?.source === source ? null : { id: bondId, source }));
  };

  const handleBondDblClick = (bondId, entry) => {
    if (run) {
      refuse(t('请先停止战斗再修改盟约层数'));
      return;
    }
    if (!entry?.active) {
      refuse(t('仅已激活的盟约可修改层数'));
      return;
    }
    const rec = content?.sim?.raw?.bonds?.[bondId];
    if (rec?.noStack) {
      refuse(t('该盟约不支持修改层数'));
      return;
    }
    setBondOpen(null);
    setLayerEditor({ bondId, initialLayers: entry.layers ?? 0 });
    audio.sfx('click', { volume: 0.4 });
  };

  const confirmBondLayers = (bondId, layers) => {
    if (edit({ type: 'setBondLayers', bondId, layers })) {
      audio.sfx('click', { volume: 0.4 });
    }
    setLayerEditor(null);
  };

  const start = () => {
    if (!hasCombatants(scene)) return;
    if (facing) cancelFacing();
    setArmed(null);
    setSel(null);
    setDetail(null);
    setBondOpen(null);
    setLayerEditor(null);
    setError('');
    setFinished(false);
    setRun(sceneSpec(content.sim, scene, terrain.goal, { config: content.config, bosses: content.bosses }));
  };

  // Underframe anchor & DetailPanel side docking (exact game.js logic).
  const ufTile = !run && !facing && dragUid == null
    ? (selPieceEntry ? pieceTile(selPieceEntry) : selEnemy ? { row: selEnemy.row, col: selEnemy.col } : null)
    : null;
  const ufGeo = useTileScreen(view, ufTile ? ufTile.row : null, ufTile ? ufTile.col : null);
  const ufShown = !!(ufTile && ufGeo);

  const ufActions = selPieceEntry
    ? { retreat: selPieceEntry.area === 'board' && selPieceEntry.piece.kind === 'chess', sell: null, destroy: true }
    : selEnemy ? { retreat: false, sell: null, destroy: true } : null;
  const ufName = selPieceEntry ? nameOf(selPieceEntry.piece) : selEnemy ? nameOf(selEnemy) : '';

  const dSide = (() => {
    if (!ufShown) return 'left';
    let rem = 100;
    try { rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100; } catch { /* default */ }
    let b;
    try { b = hudElRef.current?.getBoundingClientRect() || null; } catch { b = null; }
    const vp = b && b.width > 0 && b.height > 0 ? { left: b.left, top: b.top, width: b.width, height: b.height }
      : { left: 0, top: 0, width: globalThis.innerWidth || 1920, height: globalThis.innerHeight || 1080 };
    return panelSide(underframeRect(ufGeo, rem), panelSlots(vp, rem, { shopOpen: false }));
  })();

  const outcome = !battleStatus?.finished ? null
    : battleStatus.bossMaxHp != null && battleStatus.bossHp <= 0 ? t('已结束 · 领袖已击破')
      : battleStatus.reason === 'timeout' ? t('已结束 · 已达时限')
        : battleStatus.leaks > 0 ? t('已结束 · 漏怪 {leaks}', { leaks: battleStatus.leaks })
          : t('已结束');
  const handCount = scene.hand.filter(Boolean).length;
  const tempCount = (scene.temp || []).filter(Boolean).length;
  const activeBondCount = displayBonds.filter(b => b.active).length;
  const pickedBoss = scene.fieldMode === 'boss' && scene.bossId
    ? bossInfo.bosses.find(b => b.bossId === scene.bossId) || null
    : null;
  const bondEntry = bondOpen ? displayBonds.find(b => b.bondId === bondOpen.id) || { bondId: bondOpen.id, count: 0, active: false, tier: 0, layers: scene.bondLayers?.[bondOpen.id] ?? 0 } : null;
  const bondPlace = bondOpen?.source === 'detail' ? (dSide === 'right' ? 'besideR' : 'beside') : 'left';

  return html`<main class="ts-page" data-testid="test-scene" ref=${pageRef}>
    <header class="ts-header">
      <div class="ts-header__left">
        <a class="btn btn--ghost btn--sm" href="/"><${Icon} name="chevronLeft" class="btn__icon" />${t('返回大厅')}</a>
        <h1>${t('测试场景')}</h1>
        ${content && !run ? html`
          <span class="ts-bench-pill">${t('整备区')} <strong class="num" data-testid="test-scene-hand-count">${handCount} / ${GEO.HAND_SIZE}</strong></span>
          <span class="ts-bench-pill">${t('装备区')} <strong class="num" data-testid="test-scene-temp-count">${tempCount} / ${GEO.TEMP_SIZE}</strong></span>
          ${pickedBoss ? html`<span class="ts-bench-pill ts-boss-pill" data-testid="test-scene-picked-boss">
            ${t('Boss')} <strong>${data.lookup('bosses', pickedBoss.bossId)?.name || pickedBoss.name}</strong>
          </span>` : null}
        ` : null}
      </div>
      ${content ? html`<div class="ts-controls">
        <label class="ts-stage-pick">${t('版本')} <select data-testid="test-scene-version" value=${versionId} onChange=${e => changeVersion(e.currentTarget.value)}>
          ${VERSION_OPTIONS.map(v => html`<option key=${v.id} value=${v.id}>${t(v.label)}</option>`)}
        </select></label>
        <label class="ts-stage-pick">${t('地图')} <select data-testid="test-scene-stage" value=${mapValueOf(scene.stageId, scene.fieldMode)} onChange=${e => changeMap(e.currentTarget.value)}>
          <optgroup label=${t('普通')}>
            ${content.stages.map(s => html`<option key=${s.id} value=${s.id}>${data.lookup('stages', s.id)?.name || s.name}</option>`)}
          </optgroup>
          <optgroup label=${t('最终攻势')}>
            ${content.stages.map(s => html`<option key=${`${s.id}:boss`} value=${`${s.id}:boss`}>${`${data.lookup('stages', s.id)?.name || s.name} · ${t('最终攻势')}`}</option>`)}
          </optgroup>
        </select></label>
        ${!run && scene.fieldMode === 'boss' ? html`<div class="ts-side-switch" role="group" aria-label=${t('战场半区')}>
          <${Button} size="sm" variant=${bossSide === 'L' ? 'secondary' : 'ghost'} active=${bossSide === 'L'}
            data-testid="test-scene-side-L" aria-pressed=${String(bossSide === 'L')}
            onClick=${() => setBossSide('L')}>${t('左半场')}<//>
          <${Button} size="sm" variant=${bossSide === 'R' ? 'secondary' : 'ghost'} active=${bossSide === 'R'}
            data-testid="test-scene-side-R" aria-pressed=${String(bossSide === 'R')}
            onClick=${() => setBossSide('R')}>${t('右半场')}<//>
        </div>` : null}
        ${!run && view && bossPreview?.route ? html`<${BossRouteToggle} visible=${bossRouteVisible}
          onToggle=${() => setBossRouteVisible(visible => !visible)} />` : null}
        ${run ? html`<${Button} data-testid="test-scene-stop" onClick=${stop}>${finished ? t('返回布置') : t('停止战斗')}<//>`
          : html`<${Button} variant="primary" icon="play" disabled=${!hasCombatants(scene)} data-testid="test-scene-start" onClick=${start}>${t('开始战斗')}<//>`}
      </div>` : null}
    </header>
    ${content ? html`<div class=${`ts-body${run ? ' ts-body--combat' : ''}`} data-testid=${run ? 'test-scene-combat' : 'test-scene-editor'}>
      ${run ? null : html`<div class="ts-sidebar">
        <${Catalogue} raw=${content.sim.raw} scene=${scene} bossInfo=${bossInfo} armed=${armed}
          onPick=${pick} onSelectBossMode=${selectBossMode} onSelectBoss=${selectBoss} />
      </div>`}
      <section class="ts-stage" aria-label=${t('战场')}>
        <div class="ts-field" ref=${hostRef} data-renderer=${viewState.kind} onContextMenu=${e => e.preventDefault()} />
        ${view ? null : html`<p class="ts-loading" role="status">${t('正在载入游戏画面…')}</p>`}
        ${!run && view && viewState.kind !== 'loading' ? html`<${TempRowNotice} equipHand=${true} view=${view} count=${0} items=${0} label=${dragUid == null && !facing} />` : null}
        <div class="gm__hud ts-hud" ref=${hudElRef}>
          <div class="ts-bonds" data-testid="test-scene-bonds">
            <${BondStrip} bonds=${displayBonds} layersDisabled=${Boolean(run && scene.fieldMode === 'boss')}
              openId=${bondOpen?.id || null}
              onOpen=${id => openBond(id, 'strip')}
              onDblClick=${handleBondDblClick} />
            ${!run && activeBondCount > 0 ? html`<span class="ts-bonds__tip">${t('双击已激活盟约可修改层数')}</span>` : null}
          </div>
          <div class="ts-overlay-top">
            ${error ? html`<p class="ts-error" role="alert">${error}</p>` : null}
            ${!run && armed && scene.fieldMode !== 'boss' ? html`<div class="ts-hint">
              <span role="status">${t('点击地图放置敌人')}</span>
              <${Button} size="sm" variant="ghost" onClick=${() => setArmed(null)}>${t('取消选择')}<//>
            </div>` : null}
            ${!run && scene.fieldMode === 'boss' && !pickedBoss ? html`<div class="ts-hint">
              <span role="status">${t('请在左侧「Boss」栏选择本场 Boss')}</span>
            </div>` : null}
          </div>
          ${bondOpen ? html`<${BondPopup} bondId=${bondOpen.id} entry=${bondEntry} priv=${displayPriv}
            place=${bondPlace} over=${bondOpen.source === 'detail'}
            onClose=${() => setBondOpen(null)}
            onMember=${(chessId, items, _standInFor, diy) => {
              setDetail({ kind: 'chess', id: chessId, ...(items ? { items } : null), ...(diy ? { diy } : null) });
              setBondOpen(null);
            }} />` : null}
          ${resolved ? html`<${DetailPanel} detail=${resolved} snapHp=${snapHp} onClose=${() => { setDetail(null); setSel(null); }}
            side=${dSide} shopOpen=${false} live=${liveStats} voice=${true} unequipAllowed=${!run}
            onBond=${id => openBond(id, 'detail')}
            onUnequip=${!run && resolved.piece?.kind === 'chess' ? itemUid => edit({ type: 'unequip', uid: resolved.piece.uid, itemUid }) : null} />` : null}
          ${ufShown && ufActions ? html`<${Underframe} key=${sel.uid} view=${view} uid=${sel.uid}
            row=${ufTile.row} col=${ufTile.col} actions=${ufActions} name=${ufName}
            onRetreat=${() => { if (edit({ type: 'retreat', uid: sel.uid })) { setSel(null); setDetail(d => (d?.kind === 'piece' && d.uid === sel.uid ? null : d)); } }}
            onDestroy=${() => edit({ type: 'remove', uid: sel.uid })} />` : null}
        </div>
        ${run ? html`<p class="ts-combat__status" role="status" data-testid="test-scene-time" data-time=${battleStatus?.time}>
          ${battleStatus ? (battleStatus.bossMaxHp != null
            ? t('时间 {time} 秒 · 领袖生命 {hp} / {maxHp} · 击杀 {kills} / {total}', {
              time: battleStatus.time.toFixed(1),
              hp: battleStatus.bossHp.toLocaleString(),
              maxHp: battleStatus.bossMaxHp.toLocaleString(),
              kills: battleStatus.kills,
              total: battleStatus.total,
            })
            : t('时间 {time} 秒 · 击杀 {kills} / {total}', { time: battleStatus.time.toFixed(1), kills: battleStatus.kills, total: battleStatus.total }))
            : t('正在载入游戏画面…')}
          ${outcome ? html`<strong data-testid="test-scene-result">${outcome}</strong>` : null}
        </p>` : null}
      </section>
    </div>`
      : bootError ? html`<div class="ts-boot-wrap"><div class="ts-panel ts-boot"><p role="alert">${t('场景数据载入失败')}</p>
        <${Button} onClick=${() => setAttempt(attempt + 1)}>${t('重试')}<//></div></div>`
      : html`<div class="ts-boot-wrap"><p role="status">${t('正在载入游戏画面…')}</p></div>`}
    ${!run && facing && view ? html`<${FacingWheel} key=${`${facing.uid}:${facing.row},${facing.col}`} view=${view}
      row=${facing.row} col=${facing.col} grid=${facing.grid} healing=${facing.healing} name=${facing.name}
      onPreview=${previewFacing} onCommit=${commitFacing} onCancel=${cancelFacing} />` : null}
    ${layerEditor ? html`<${BondLayerDialog} bondId=${layerEditor.bondId} initialLayers=${layerEditor.initialLayers}
      onConfirm=${confirmBondLayers} onCancel=${() => setLayerEditor(null)} />` : null}
    ${replace ? html`<${EquipReplaceDialog} request=${replace.request} getItem=${id => data.lookup('items', id)}
      onConfirm=${uid => closeReplace(uid)} onCancel=${() => closeReplace(null)} />` : null}
    <${ToastHost} />
  </main>`;
}

installDeviceSupport();
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
await initLang();
render(html`<${TestScene} />`, document.getElementById('app'));
