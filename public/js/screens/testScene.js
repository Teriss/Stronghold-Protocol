import { render } from '../../vendor/preact.module.js';
import { useCallback, useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { GEO } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { data, useData } from '../data.js';
import { loadBrowserSim, SIM_DATA_FILES } from '../battle/simLoader.js';
import { makeRunner } from '../battle/localPlayback.js';
import {
  BATTLE_CAP, DEFAULT_STAGE, canPlaceInScene, chessRecordOf, editScene, emptyScene, hasCombatants,
  legalTilesFor, prepViewState, sceneEquipment, sceneOperators, sceneSpec, sceneStages, sceneTerrain,
} from '../battle/testSceneModel.js';
import { diyRecord } from '../../../shared/diy.js';
import { Button, html, Icon } from '../ui/components.js';
import { Img } from '../ui/gameComponents.js';
import { chessAvatarUrl, enemyIconUrl, itemIconUrl } from '../ui/assetUrls.js';
import { mountFieldView } from '../ui/fieldHost.js';
import { FacingWheel, holdPiece, setPieceDir, showRange, syncPieceDirs } from '../ui/facingWheel.js';
import { previewGrid, previewRecord } from '../ui/facing.js';
import { isHealingRange, rangeStyle } from '../ui/rangeStyle.js';
import { initLang, useLang } from '../ui/lang.js';

const FILES = { chess: 'chess', item: 'items', enemy: 'enemies' };
const ICONS = { chess: 'user', item: 'shield', enemy: 'sword' };
const DIR_GLYPH = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
const TEST_SCENE_HUD = () => ({ top: 44, bottom: 18 });
const TEST_SCENE_PADDING = () => ({ top: 44, bottom: 24, left: 20, right: 20 });

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

function Portrait({ kind, id, diy }) {
  const rec = recordOf({ kind, id, diy });
  const assets = data.get('assets');
  const src = kind === 'chess' ? chessAvatarUrl(assets, rec) : kind === 'item' ? itemIconUrl(assets, rec) : enemyIconUrl(assets, id);
  return html`<span class="ts-portrait" aria-hidden="true">
    <${Img} src=${src} fallback=${html`<${Icon} name=${ICONS[kind]} />`} />
  </span>`;
}

function Catalogue({ raw, armed, onPick }) {
  const lang = useLang();
  const [kind, setKind] = useState('chess');
  const [query, setQuery] = useState('');
  const file = FILES[kind];
  const localized = data.get(file);
  const backups = data.get('backups');
  const rows = useMemo(() => {
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
  }, [kind, raw, file, localized, backups, lang]);
  const q = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => [row.name, row.original, row.id, row.charId].some(text => text?.toLocaleLowerCase().includes(q)));
  return html`<aside class="ts-catalogue" data-testid="test-scene-catalogue">
    <div class="ts-kinds" role="group" aria-label=${t('选择类型')}>
      ${[['chess', t('干员')], ['item', t('装备')], ['enemy', t('敌人')]].map(([key, label]) => html`
        <button type="button" key=${key} aria-pressed=${kind === key} data-kind=${key} onClick=${() => { setKind(key); setQuery(''); }}>${label}</button>`)}
    </div>
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
  </aside>`;
}

function Selection({ piece, onEdit }) {
  if (!piece) return null;
  const { uid, kind, dir, items, row } = piece;
  return html`<section class="ts-selection" data-testid="test-scene-selection">
    <div class="ts-selection__head">
      <${Portrait} kind=${kind} id=${piece.id} diy=${piece.diy} />
      <h2>${nameOf(piece)}</h2>
    </div>
    ${items?.length ? html`<div class="ts-worn-list">${items.map(item => html`<div class="ts-worn" key=${item.uid} data-equipped=${item.id}>
      <span>${nameOf(item)}</span>
      <${Button} size="sm" onClick=${() => onEdit({ type: 'unequip', uid, itemUid: item.uid })}>${t('卸下装备')}<//>
    </div>`)}</div>` : null}
    <div class="ts-selection__actions">
      ${kind === 'chess' && row != null ? html`
        <label>${t('朝向')} <select value=${dir} onChange=${e => onEdit({ type: 'face', uid, dir: e.currentTarget.value })}>
          ${Object.entries(DIR_GLYPH).map(([key, arrow]) => html`<option key=${key} value=${key}>${arrow}</option>`)}
        </select></label>
        <${Button} size="sm" onClick=${() => onEdit({ type: 'retreat', uid })}>${t('撤退')}<//>
      ` : null}
      <${Button} size="sm" onClick=${() => onEdit({ type: 'remove', uid })}>${t('移除')}<//>
    </div>
  </section>`;
}

function TestScene() {
  const lang = useLang();
  useData('stages', 'chess', 'enemies', 'items', 'backups', 'assets', 'local');
  const hostRef = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState(null);
  const [bootError, setBootError] = useState(false);
  const [viewState, setViewState] = useState({ view: null, kind: 'loading' });
  const [scene, setScene] = useState(emptyScene);
  const [selection, setSelection] = useState(null);
  const [dragUid, setDragUid] = useState(null);
  const [facing, setFacing] = useState(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState(null);
  const [finished, setFinished] = useState(false);
  const [battleStatus, setBattleStatus] = useState(null);
  const stageAppliedRef = useRef(null);
  const modeRef = useRef('init');
  const ptrRef = useRef({ tile: null, released: false });

  useEffect(() => { document.title = t('测试场景'); }, [lang]);

  useEffect(() => {
    let active = true;
    const files = [...SIM_DATA_FILES, 'config'];
    setBootError(false);
    if (attempt > 0) for (const name of ['assets', 'local']) if (data.status(name) === 'missing') data.invalidate(name);
    (async () => {
      const values = await Promise.all(files.map(name => data.status(name) === 'missing' ? data.invalidate(name) : data.load(name)));
      if (values.some(value => !value)) throw new Error('test-scene data unavailable');
      const sim = await loadBrowserSim({ reuse: name => data.getRaw(name), reuseOwner: () => data.contentId() });
      const stages = sceneStages(sim.raw.stages);
      if (!stages.some(stage => stage.id === DEFAULT_STAGE)) throw new Error('default test-scene stage unavailable');
      if (active) setContent({ sim, stages, config: data.getRaw('config') });
    })().catch(() => { if (active) setBootError(true); });
    return () => { active = false; };
  }, [attempt]);

  const stage = content?.sim.raw.stages[scene.stageId];
  const terrain = useMemo(() => content && sceneTerrain(content.sim, scene.stageId), [content, scene.stageId]);
  const lookups = useMemo(() => content && ({
    getChess: id => content.sim.raw.chess[id],
    getToken: id => content.sim.raw.tokens[id],
    getItem: id => content.sim.raw.items[id],
  }), [content]);
  const selected = [...scene.hand, ...scene.board, ...scene.enemies].find(p => p && p.uid === selection?.uid);
  const armed = selection?.enemy;
  const view = viewState.view;

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
  const edit = useCallback((action, nextSelection) => {
    const L = live.current;
    if (!L.content || !L.terrain) return false;
    const result = editScene(L.scene, action, { ...L.content, terrain: L.terrain });
    if (result.error) { setError(result.error); return false; }
    setError('');
    setScene(result.scene);
    const sel = nextSelection === undefined ? L.selection : nextSelection;
    setSelection(action.type === 'remove' ? null : sel);
    return true;
  }, []);

  live.current = { content, terrain, scene, selection, selected, armed, run, facing, lookups, edit };

  // Sync prep scene (operators, equipment, bench pads, placed enemies) into the live renderer.
  useEffect(() => {
    if (!view || !content || !stage || run) return;
    const stageChanged = stageAppliedRef.current !== scene.stageId;
    if (stageChanged) {
      view.setStage(stage);
      stageAppliedRef.current = scene.stageId;
    }
    const enteringPrep = modeRef.current !== 'prep';
    modeRef.current = 'prep';
    const prepPriv = prepViewState(scene, nameOf);
    view.setPrep(prepPriv, {
      editable: true,
      canPlace: (uid, target) => canPlaceInScene(live.current.scene, uid, target, { ...live.current.content, terrain: live.current.terrain }),
    });
    if (enteringPrep || stageChanged) view.setCamera('prep', { shop: false, instant: true });
    syncPieceDirs(view, prepPriv, facing?.uid ?? null);
  }, [view, content, stage, scene, run, facing]);

  // Highlight legal tiles or rotated attack range in the scene during editing.
  useEffect(() => {
    if (!view || !content || !terrain || run) return;
    if (facing) return;
    view.highlightTiles(null, null);
    const ctx = { ...content, terrain };
    if (dragUid != null) {
      view.highlightTiles(legalTilesFor(scene, { uid: dragUid }, ctx), 'legal');
      return;
    }
    if (armed) {
      view.highlightTiles(legalTilesFor(scene, { enemy: armed }, ctx), 'legal');
      return;
    }
    if (!selected) return;
    if (selected.kind === 'chess' && selected.row != null) {
      const resolvedLookups = pieceLookups(lookups, content.sim.raw, selected);
      const grid = previewGrid(resolvedLookups, selected);
      if (grid) showRange(view, grid, selected.row, selected.col, selected.dir, rangeStyle(isHealingRange(previewRecord(resolvedLookups, selected))));
      return;
    }
    if (selected.kind === 'chess' || selected.kind === 'item') {
      view.highlightTiles(legalTilesFor(scene, { uid: selected.uid }, ctx), 'legal');
    }
  }, [view, content, terrain, scene, run, facing, dragUid, armed, selected, lookups]);

  // Wire field interactions: drag & drop, facing wheel, click-to-deploy/equip/place/select.
  useEffect(() => {
    if (!view) return undefined;
    let moveOff = null;
    const endDrag = () => { moveOff?.(); moveOff = null; setDragUid(null); };
    const openFacing = (piece, row, col) => {
      const L = live.current;
      const resolvedLookups = pieceLookups(L.lookups, L.content.sim.raw, piece);
      view.highlightTiles(null, null);
      holdPiece(view, piece.uid, { row, col });
      setSelection(null);
      setFacing({
        uid: piece.uid, piece, row, col,
        grid: previewGrid(resolvedLookups, piece),
        healing: isHealingRange(previewRecord(resolvedLookups, piece)),
        name: nameOf(piece),
      });
    };
    const offs = [
      view.on('pieceDragStart', e => {
        const L = live.current;
        if (!e || L.run || !L.content) return;
        setFacing(null);
        setSelection(null);
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
        const t = e.target || {};
        if (t.area === 'outside') return;
        const piece = [...L.scene.hand, ...L.scene.board].find(p => p?.uid === e.uid);
        if (!piece) return;
        const ctx = { ...L.content, terrain: L.terrain };
        if (t.area === 'board') {
          if (piece.kind === 'item') {
            const occ = L.scene.board.find(p => p.row === t.row && p.col === t.col);
            if (!occ) { setError(t('装备只能配发给干员')); return; }
            L.edit({ type: 'equip', uid: piece.uid, target: occ.uid }, { uid: occ.uid });
            return;
          }
          if (piece.kind === 'chess') {
            const probe = editScene(L.scene, { type: 'deploy', uid: piece.uid, row: t.row, col: t.col }, ctx);
            if (probe.error) { setError(probe.error); return; }
            openFacing(piece, t.row, t.col);
          }
          return;
        }
        if (t.area === 'hand') {
          const occ = L.scene.hand[t.idx];
          if (piece.kind === 'item' && occ?.kind === 'chess') {
            L.edit({ type: 'equip', uid: piece.uid, target: occ.uid }, { uid: occ.uid });
          } else if (piece.row != null) {
            L.edit({ type: 'retreat', uid: piece.uid, idx: t.idx }, { uid: piece.uid });
          } else {
            L.edit({ type: 'moveHand', uid: piece.uid, idx: t.idx }, { uid: piece.uid });
          }
        }
      }),
      view.on('pieceDragEnd', e => {
        const { released, tile } = ptrRef.current;
        endDrag();
        const L = live.current;
        if (!e || e.dropped || !released || L.run || !L.content || !L.terrain || !tile) return;
        const piece = [...L.scene.hand, ...L.scene.board].find(p => p?.uid === e.uid);
        if (!piece) return;
        const ctx = { ...L.content, terrain: L.terrain };
        if (tile.area === 'board' && Number.isInteger(tile.row) && Number.isInteger(tile.col)) {
          if (piece.kind === 'item') {
            const occ = L.scene.board.find(p => p.row === tile.row && p.col === tile.col);
            const res = occ ? editScene(L.scene, { type: 'equip', uid: piece.uid, target: occ.uid }, ctx) : { error: t('装备只能配发给干员') };
            if (res.error) setError(res.error);
          } else if (piece.kind === 'chess') {
            const res = editScene(L.scene, { type: 'deploy', uid: piece.uid, row: tile.row, col: tile.col }, ctx);
            if (res.error) setError(res.error);
          }
        } else if (tile.area === 'hand' && Number.isInteger(tile.idx)) {
          const occ = L.scene.hand[tile.idx];
          if (piece.kind === 'item' && occ?.kind === 'chess') {
            const res = editScene(L.scene, { type: 'equip', uid: piece.uid, target: occ.uid }, ctx);
            if (res.error) setError(res.error);
          } else if (piece.row != null) {
            const res = editScene(L.scene, { type: 'retreat', uid: piece.uid, idx: tile.idx }, ctx);
            if (res.error) setError(res.error);
          }
        }
      }),
      view.on('pieceClick', e => {
        const L = live.current;
        if (!e || L.run || L.facing) return;
        if (L.armed) {
          const boardPiece = e.prepMapChar ? L.scene.enemies.find(p => p.uid === e.uid) : L.scene.board.find(p => p.uid === e.uid);
          if (boardPiece) {
            L.edit({ type: 'enemy', id: L.armed, row: boardPiece.row, col: boardPiece.col });
            return;
          }
        }
        if (e.prepMapChar) {
          const enemyPiece = L.scene.enemies.find(p => p.uid === e.uid);
          if (enemyPiece) { setError(''); setSelection({ uid: enemyPiece.uid }); }
          return;
        }
        const piece = [...L.scene.hand, ...L.scene.board].find(p => p?.uid === e.uid);
        if (!piece) return;
        if (L.selected?.kind === 'item' && piece.kind === 'chess') {
          L.edit({ type: 'equip', uid: L.selected.uid, target: piece.uid }, { uid: piece.uid });
        } else {
          setError('');
          setSelection({ uid: piece.uid });
        }
      }),
      view.on('tileClick', tile => {
        const L = live.current;
        if (!tile || !Number.isInteger(tile.row) || !Number.isInteger(tile.col) || L.run || L.facing) return;
        if (L.armed) {
          L.edit({ type: 'enemy', id: L.armed, row: tile.row, col: tile.col });
        } else if (L.selected?.kind === 'chess') {
          L.edit({ type: 'deploy', uid: L.selected.uid, row: tile.row, col: tile.col });
        } else {
          setError('');
          setSelection(null);
        }
      }),
    ];
    return () => { endDrag(); for (const off of offs) { try { off?.(); } catch { /* ignore */ } } };
  }, [view]);

  // Run local fixed-tick battle on the same live field renderer.
  useEffect(() => {
    if (!view || !content || !run) { setBattleStatus(null); return undefined; }
    let active = true, runner = null, raf = 0;
    const stopLoop = () => {
      active = false;
      cancelAnimationFrame(raf);
      runner?.pause();
      view.raw.setLocalFeed?.({ on: false });
    };
    window.addEventListener('pagehide', stopLoop);
    try {
      modeRef.current = 'battle';
      view.highlightTiles(null, null);
      const battle = content.sim.spec.createBattleFromSpec(run, content.sim.ds, { quiet: true });
      if (!run.spawns.length) battle.autoFinish = false;
      if (stageAppliedRef.current !== run.stageId) {
        view.setStage(content.sim.raw.stages[run.stageId]);
        stageAppliedRef.current = run.stageId;
      }
      view.enterBattle(battle.fieldMeta());
      view.setCamera('normal', { rect: run.rect, instant: true });
      view.raw.setLocalFeed?.({ on: true, speed: 1 });
      runner = makeRunner(battle, { cap: BATTLE_CAP, onFrame: (snap, events) => {
        view.pushEvents({ t: 'b.ev', fieldId: snap.fieldId, gt: snap.t, ev: events });
        view.pushSnapshot({ ...snap, t: 'b.snap', gt: snap.t });
      } });
      const publish = () => {
        if (!active) return;
        setBattleStatus({
          time: battle.time, kills: battle.killedInTotal, leaks: battle.leakedCount,
          total: battle.total, finished: battle.finished, reason: battle.reason, renderer: view.kind,
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

  const cancelFacing = useCallback(() => {
    if (view && facing) holdPiece(view, facing.uid, null);
    setFacing(null);
  }, [view, facing]);
  const previewFacing = useCallback(dir => {
    if (!view || !facing) return;
    setPieceDir(view, facing.uid, dir || facing.piece.dir);
  }, [view, facing]);
  const commitFacing = useCallback(dir => {
    if (!facing) return;
    if (view) holdPiece(view, facing.uid, null);
    const f = facing;
    setFacing(null);
    edit({ type: 'deploy', uid: f.uid, row: f.row, col: f.col, dir }, { uid: f.uid });
  }, [view, facing, edit]);

  const stop = () => {
    if (view && facing) holdPiece(view, facing.uid, null);
    setFacing(null);
    setRun(null);
    setFinished(false);
    setError('');
  };
  const changeStage = id => {
    if (id === scene.stageId) return;
    stop();
    setScene(emptyScene(id));
    setSelection(null);
  };
  const select = p => { setError(''); setSelection(p ? { uid: p.uid } : null); };
  const pick = (kind, id, diy = null) => {
    if (run) return;
    if (kind === 'enemy') { setError(''); setSelection(armed === id ? null : { enemy: id }); }
    else edit({ type: 'add', kind, id, ...(diy ? { diy } : null) }, { uid: scene.nextUid });
  };
  const start = () => {
    if (!hasCombatants(scene)) return;
    if (view && facing) holdPiece(view, facing.uid, null);
    setFacing(null);
    setSelection(null);
    setError('');
    setFinished(false);
    setRun(sceneSpec(content.sim, scene, terrain.goal));
  };

  const outcome = !battleStatus?.finished ? null
    : battleStatus.reason === 'timeout' ? t('已结束 · 已达时限')
      : battleStatus.leaks > 0 ? t('已结束 · 漏怪 {leaks}', { leaks: battleStatus.leaks })
        : t('已结束');
  const handCount = scene.hand.filter(Boolean).length;

  return html`<main class="ts-page" data-testid="test-scene">
    <header class="ts-header">
      <div class="ts-header__left">
        <a class="btn btn--ghost btn--sm" href="/"><${Icon} name="chevronLeft" class="btn__icon" />${t('返回大厅')}</a>
        <h1>${t('测试场景')}</h1>
        ${content && !run ? html`<span class="ts-bench-pill">${t('整备区')} <strong class="num" data-testid="test-scene-hand-count">${handCount} / ${GEO.HAND_SIZE}</strong></span>` : null}
      </div>
      ${content ? html`<div class="ts-controls">
        <label class="ts-stage-pick">${t('地图')} <select data-testid="test-scene-stage" value=${scene.stageId} onChange=${e => changeStage(e.currentTarget.value)}>
          ${content.stages.map(s => html`<option key=${s.id} value=${s.id}>${data.lookup('stages', s.id)?.name || s.name}</option>`)}
        </select></label>
        ${run ? html`<${Button} data-testid="test-scene-stop" onClick=${stop}>${finished ? t('返回布置') : t('停止战斗')}<//>`
          : html`<${Button} variant="primary" icon="play" disabled=${!hasCombatants(scene)} data-testid="test-scene-start" onClick=${start}>${t('开始战斗')}<//>`}
      </div>` : null}
    </header>
    ${content ? html`<div class=${`ts-body${run ? ' ts-body--combat' : ''}`} data-testid=${run ? 'test-scene-combat' : 'test-scene-editor'}>
      ${run ? null : html`<div class="ts-sidebar">
        <${Catalogue} raw=${content.sim.raw} armed=${armed} onPick=${pick} />
        <${Selection} piece=${selected} onEdit=${edit} />
      </div>`}
      <section class="ts-stage" aria-label=${t('战场')}>
        <div class="ts-field" ref=${hostRef} data-renderer=${viewState.kind} />
        ${view ? null : html`<p class="ts-loading" role="status">${t('正在载入游戏画面…')}</p>`}
        <div class="ts-overlay-top">
          ${error ? html`<p class="ts-error" role="alert">${error}</p>` : null}
          ${!run ? html`<div class="ts-hint">
            <span role="status">${armed ? t('点击地图放置敌人') : selected?.kind === 'item' ? t('选择干员配发装备')
              : selected?.kind === 'chess' ? t('点击地图部署干员') : t('从列表添加干员、装备或敌人')}</span>
            ${selection ? html`<${Button} size="sm" variant="ghost" onClick=${() => select(null)}>${t('取消选择')}<//>` : null}
          </div>` : null}
        </div>
        ${!run && facing && view ? html`<${FacingWheel} key=${`${facing.uid}:${facing.row},${facing.col}`} view=${view}
          row=${facing.row} col=${facing.col} grid=${facing.grid} healing=${facing.healing} name=${facing.name}
          onPreview=${previewFacing} onCommit=${commitFacing} onCancel=${cancelFacing} />` : null}
        ${run ? html`<p class="ts-combat__status" role="status" data-testid="test-scene-time" data-time=${battleStatus?.time}>
          ${battleStatus ? t('时间 {time} 秒 · 击杀 {kills} / {total}', { time: battleStatus.time.toFixed(1), kills: battleStatus.kills, total: battleStatus.total })
            : t('正在载入游戏画面…')}
          ${outcome ? html`<strong data-testid="test-scene-result">${outcome}</strong>` : null}
        </p>` : null}
      </section>
    </div>`
      : bootError ? html`<div class="ts-boot-wrap"><div class="ts-panel ts-boot"><p role="alert">${t('场景数据载入失败')}</p>
        <${Button} onClick=${() => setAttempt(attempt + 1)}>${t('重试')}<//></div></div>`
      : html`<div class="ts-boot-wrap"><p role="status">${t('正在载入游戏画面…')}</p></div>`}
  </main>`;
}

window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
await initLang();
render(html`<${TestScene} />`, document.getElementById('app'));
