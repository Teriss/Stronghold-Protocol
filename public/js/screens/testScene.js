import { render } from '../../vendor/preact.module.js';
import { useCallback, useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { GEO } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { data, useData } from '../data.js';
import { loadBrowserSim, SIM_DATA_FILES } from '../battle/simLoader.js';
import { makeRunner } from '../battle/localPlayback.js';
import { BATTLE_CAP, DEFAULT_STAGE, editScene, emptyScene, hasCombatants, sceneEquipment, sceneSpec, sceneStages, sceneTerrain } from '../battle/testSceneModel.js';
import { Button, html, Icon } from '../ui/components.js';
import { Img } from '../ui/gameComponents.js';
import { chessAvatarUrl, enemyIconUrl, itemIconUrl } from '../ui/assetUrls.js';
import { mountFieldView } from '../ui/fieldHost.js';
import { initLang, useLang } from '../ui/lang.js';
import { stagePreviewCells } from '../ui/stagePreview.js';

const FILES = { chess: 'chess', item: 'items', enemy: 'enemies' };
const ICONS = { chess: 'user', item: 'shield', enemy: 'sword' };
const DIR_GLYPH = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
const nameOf = ({ id, kind }) => data.lookup(FILES[kind], id)?.name || id;

function Portrait({ kind, id }) {
  const rec = data.lookup(FILES[kind], id);
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
  const rows = useMemo(() => Object.entries(raw[file])
    .filter(([, rec]) => kind === 'chess' ? !rec.isDiy : kind === 'item' ? sceneEquipment(rec) : true)
    .map(([id, rec]) => ({ id, name: nameOf({ id, kind }), original: rec.name, golden: rec.isGolden }))
    .sort((a, b) => a.name.localeCompare(b.name, lang) || a.id.localeCompare(b.id)), [kind, raw, localized, lang]);
  const q = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => [row.name, row.original, row.id].some(text => text?.toLocaleLowerCase().includes(q)));
  return html`<aside class="ts-catalogue ts-panel">
    <div class="ts-kinds" role="group" aria-label=${t('选择类型')}>
      ${[['chess', t('干员')], ['item', t('装备')], ['enemy', t('敌人')]].map(([key, label]) => html`
        <button type="button" key=${key} aria-pressed=${kind === key} data-kind=${key} onClick=${() => { setKind(key); setQuery(''); }}>${label}</button>`)}
    </div>
    <input class="ts-search" type="search" value=${query} aria-label=${t('搜索名称或 ID')} placeholder=${t('搜索名称或 ID')}
      onInput=${event => setQuery(event.currentTarget.value)} />
    <ul class="ts-catalogue__list" aria-label=${t('搜索结果')}>
      ${filtered.map(({ id, name, golden }) => html`<li key=${id}>
        <button type="button" class="ts-pick" data-record=${id} title=${name} aria-pressed=${kind === 'enemy' ? armed === id : undefined}
          onClick=${() => onPick(kind, id)}>
          <${Portrait} kind=${kind} id=${id} />
          <span>${name}</span>${golden ? html`<small>${t('精锐')}</small>` : null}
          <${Icon} name=${kind === 'enemy' ? 'chevronRight' : 'plus'} />
        </button>
      </li>`)}
      ${filtered.length ? null : html`<li class="ts-muted">${t('没有匹配项')}</li>`}
    </ul>
  </aside>`;
}

function Board({ stage, scene, terrain, selected, onTile, onPiece }) {
  const pieces = new Map([...scene.board, ...scene.enemies].map(p => [terrain.grid.key(p.row, p.col), p]));
  return html`<section class="ts-panel ts-layout" aria-label=${t('战场')}>
    <div class="ts-grid">
      ${stagePreviewCells(stage, GEO.NORMAL_RECT).map(({ row, col, kind }) => {
        const key = terrain.grid.key(row, col), p = pieces.get(key);
        const label = t('第 {row} 行，第 {col} 列', { row, col });
        const reserved = terrain.reserved.has(key);
        return html`<button type="button" key=${key} class=${`ts-cell ts-cell--${kind}`} data-row=${row} data-col=${col}
          data-piece=${p?.id} data-side=${p?.kind} aria-pressed=${p ? selected?.uid === p.uid : undefined}
          aria-label=${p ? `${label} · ${nameOf(p)}` : label} title=${p ? nameOf(p) : label}
          onClick=${() => onTile(row, col, p)}>
          ${p ? html`<${Portrait} kind=${p.kind} id=${p.id} />${p.dir ? html`<span class="ts-facing" aria-hidden="true">${DIR_GLYPH[p.dir]}</span>` : null}`
            : reserved ? html`<${Icon} name="shield" />` : null}
        </button>`;
      })}
    </div>
    <div class="ts-bench-heading">
      <h2>${t('整备区')}</h2><span class="num" data-testid="test-scene-hand-count">${scene.hand.filter(Boolean).length} / ${GEO.HAND_SIZE}</span>
    </div>
    <div class="ts-bench">
      ${scene.hand.map((p, idx) => p ? html`<button type="button" key=${idx} class="ts-slot" data-piece=${p.id} data-slot=${idx}
        aria-pressed=${selected?.uid === p.uid} title=${nameOf(p)} onClick=${() => onPiece(p)}>
          <${Portrait} kind=${p.kind} id=${p.id} /><span>${nameOf(p)}</span>
        </button>` : html`<div class="ts-slot ts-slot--empty" key=${idx} aria-hidden="true"></div>`)}
    </div>
  </section>`;
}

function Selection({ piece, onEdit }) {
  if (!piece) return null;
  const { uid, kind, dir, items, row } = piece;
  return html`<section class="ts-panel ts-selection" data-testid="test-scene-selection">
    <div class="ts-selection__head"><${Portrait} kind=${kind} id=${piece.id} /><h2>${nameOf(piece)}</h2></div>
    ${items?.map(item => html`<div class="ts-worn" key=${item.uid} data-equipped=${item.id}>
      <span>${nameOf(item)}</span>
      <${Button} size="sm" onClick=${() => onEdit({ type: 'unequip', uid, itemUid: item.uid })}>${t('卸下装备')}<//>
    </div>`)}
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

function BattlePreview({ sim, spec, onFinish, onFailure }) {
  const host = useRef(null);
  const [status, setStatus] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let view, runner, raf = 0;
    const onResize = () => view?.resize();
    const dispose = () => {
      controller.abort();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      runner?.pause();
      view?.destroy();
      view = null;
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', dispose);
    (async () => {
      const field = await mountFieldView(host.current, { signal: controller.signal });
      if (controller.signal.aborted) { field.destroy(); return; }
      view = field;
      const battle = sim.spec.createBattleFromSpec(spec, sim.ds, { quiet: true });
      if (!spec.spawns.length) battle.autoFinish = false;
      view.setStage(sim.raw.stages[spec.stageId]);
      view.enterBattle(battle.fieldMeta());
      view.setCamera('normal', { rect: spec.rect, instant: true });
      view.raw.setLocalFeed?.({ on: true, speed: 1 });
      runner = makeRunner(battle, { cap: BATTLE_CAP, onFrame: (snap, events) => {
        view.pushEvents({ t: 'b.ev', fieldId: snap.fieldId, gt: snap.t, ev: events });
        view.pushSnapshot({ ...snap, t: 'b.snap', gt: snap.t });
      } });
      const publish = () => setStatus({ time: battle.time, kills: battle.killedInTotal, leaks: battle.leakedCount,
        total: battle.total, finished: battle.finished, reason: battle.reason, renderer: field.kind });
      runner.play();
      publish();
      let last = performance.now(), lastStatus = last;
      const frame = now => {
        runner.advance((now - last) / 1000);
        last = now;
        if (battle.finished || now - lastStatus >= 100) { publish(); lastStatus = now; }
        if (battle.finished) onFinish(true);
        else raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    })().catch(error => { if (!controller.signal.aborted) { dispose(); onFailure(error); } });
    return () => { window.removeEventListener('pagehide', dispose); dispose(); };
  }, [sim, spec, onFinish, onFailure]);
  const outcome = !status?.finished ? null
    : status.reason === 'timeout' ? t('已结束 · 已达时限')
      : status.leaks > 0 ? t('已结束 · 漏怪 {leaks}', { leaks: status.leaks })
        : t('已结束');
  return html`<section class="ts-panel ts-combat" data-testid="test-scene-combat">
    <div class="ts-combat__field" ref=${host} data-renderer=${status?.renderer} />
    <p class="ts-combat__status" role="status" data-testid="test-scene-time" data-time=${status?.time}>
      ${status ? t('时间 {time} 秒 · 击杀 {kills} / {total}', { time: status.time.toFixed(1), kills: status.kills, total: status.total })
        : t('正在载入游戏画面…')}
      ${outcome ? html`<strong data-testid="test-scene-result">${outcome}</strong>` : null}
    </p>
  </section>`;
}

function TestScene() {
  const lang = useLang();
  useData('stages', 'chess', 'enemies', 'items', 'assets', 'local');
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState(null);
  const [bootError, setBootError] = useState(false);
  const [scene, setScene] = useState(emptyScene);
  const [selection, setSelection] = useState(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState(null);
  const [finished, setFinished] = useState(false);
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
  const battleFailure = useCallback(err => {
    console.warn('[test scene] battle view failed:', err);
    setRun(null);
    setFinished(false);
    setError(t('战斗载入失败，请重试'));
  }, []);
  const selected = [...scene.hand, ...scene.board, ...scene.enemies].find(p => p && p.uid === selection?.uid);
  const armed = selection?.enemy;

  const stop = () => { setRun(null); setFinished(false); setError(''); };
  const changeStage = id => {
    if (id === scene.stageId) return;
    stop();
    setScene(emptyScene(id));
    setSelection(null);
  };
  const edit = (action, nextSelection = selection) => {
    const result = editScene(scene, action, { ...content, terrain });
    if (result.error) { setError(result.error); return; }
    setError('');
    setScene(result.scene);
    setSelection(action.type === 'remove' ? null : nextSelection);
  };
  const select = p => { setError(''); setSelection(p ? { uid: p.uid } : null); };
  const pick = (kind, id) => {
    if (kind === 'enemy') { setError(''); setSelection(armed === id ? null : { enemy: id }); }
    else edit({ type: 'add', kind, id }, { uid: scene.nextUid });
  };
  const clickPiece = p => {
    if (selected?.kind === 'item' && p.kind === 'chess') edit({ type: 'equip', uid: selected.uid, target: p.uid }, { uid: p.uid });
    else select(p);
  };
  const clickTile = (row, col, p) => {
    if (armed) edit({ type: 'enemy', id: armed, row, col });
    else if (p) clickPiece(p);
    else if (selected?.kind === 'chess') edit({ type: 'deploy', uid: selected.uid, row, col });
    else select(null);
  };
  const start = () => {
    if (!hasCombatants(scene)) return;
    setError('');
    setRun(sceneSpec(content.sim, scene, terrain.goal));
  };

  return html`<main class="ts-page" data-testid="test-scene">
    <header class="ts-header">
      <a class="btn btn--ghost btn--sm" href="/"><${Icon} name="chevronLeft" class="btn__icon" />${t('返回大厅')}</a>
      <h1>${t('测试场景')}</h1>
      ${content ? html`<div class="ts-controls">
        <label>${t('地图')} <select data-testid="test-scene-stage" value=${scene.stageId} onChange=${e => changeStage(e.currentTarget.value)}>
          ${content.stages.map(s => html`<option key=${s.id} value=${s.id}>${data.lookup('stages', s.id)?.name || s.name}</option>`)}
        </select></label>
        ${run ? html`<${Button} data-testid="test-scene-stop" onClick=${stop}>${finished ? t('返回布置') : t('停止战斗')}<//>`
          : html`<${Button} variant="primary" icon="play" disabled=${!hasCombatants(scene)} data-testid="test-scene-start" onClick=${start}>${t('开始战斗')}<//>`}
      </div>` : null}
    </header>
    ${error ? html`<p class="ts-error" role="alert">${error}</p>` : null}
    ${content ? run ? html`<${BattlePreview} sim=${content.sim} spec=${run} onFinish=${setFinished} onFailure=${battleFailure} />`
      : html`<div class="ts-editor" data-testid="test-scene-editor">
        <${Catalogue} raw=${content.sim.raw} armed=${armed} onPick=${pick} />
        <div class="ts-workspace">
          <${Board} stage=${stage} scene=${scene} terrain=${terrain} selected=${selected} onTile=${clickTile} onPiece=${clickPiece} />
          <div class="ts-hint">
            <span role="status">${armed ? t('点击地图放置敌人') : selected?.kind === 'item' ? t('选择干员配发装备')
              : selected?.kind === 'chess' ? t('点击地图部署干员') : t('从列表添加干员、装备或敌人')}</span>
            ${selection ? html`<${Button} size="sm" variant="ghost" onClick=${() => select(null)}>${t('取消选择')}<//>` : null}
          </div>
          <${Selection} piece=${selected} onEdit=${edit} />
        </div>
      </div>`
      : bootError ? html`<div class="ts-panel ts-boot"><p role="alert">${t('场景数据载入失败')}</p>
        <${Button} onClick=${() => setAttempt(attempt + 1)}>${t('重试')}<//></div>`
      : html`<p role="status">${t('正在载入游戏画面…')}</p>`}
  </main>`;
}

window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
await initLang();
render(html`<${TestScene} />`, document.getElementById('app'));
