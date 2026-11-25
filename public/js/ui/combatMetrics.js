import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, useTicker } from './components.js';
import { UnitThumb, PlayerAvatar } from './gameComponents.js';
import { sortedPlayers } from './gameLogic.js';
import { useStore } from '../store.js';
import { battleRunner } from '../battle/runner.js';
import { t, N_ } from '../../../shared/i18n.js';
import { combatMetricsLayout } from './combatMetricsLayout.js';

const TYPES = Object.freeze([
  { id: 'phys', label: N_('物理') }, { id: 'arts', label: N_('法术') },
  { id: 'true', label: N_('真实') }, { id: 'elemental', label: N_('元素') },
]);
const number = (n) => Math.round(n || 0).toLocaleString('zh-CN');
const rate = (n) => (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 });

/** Aggregate operator rows into one total row per player (for the ALL tab). */
export function summarizeByPlayer(rows, players) {
  const byOwner = new Map();
  for (const r of rows || []) {
    let entry = byOwner.get(r.ownerId);
    if (!entry) {
      entry = { ownerId: r.ownerId, damage: 0, healing: 0, seconds: 0, types: { phys: 0, arts: 0, true: 0, elemental: 0 } };
      byOwner.set(r.ownerId, entry);
    }
    entry.damage += r.damage || 0;
    entry.healing += r.healing || 0;
    if ((r.seconds || 0) > entry.seconds) entry.seconds = r.seconds || 0;
    for (const type of TYPES) entry.types[type.id] += r.types?.[type.id] || 0;
  }
  if (!byOwner.size) return [];
  const out = [];
  const seen = new Set();
  for (const p of players || []) {
    seen.add(p.playerId);
    const agg = byOwner.get(p.playerId) || { ownerId: p.playerId, damage: 0, healing: 0, seconds: 0, types: { phys: 0, arts: 0, true: 0, elemental: 0 } };
    const dps = agg.seconds > 0 ? agg.damage / agg.seconds : 0;
    const hps = agg.seconds > 0 ? agg.healing / agg.seconds : 0;
    out.push({ key: p.playerId, ownerId: p.playerId, player: p, name: p.name || '', seat: p.seat ?? 99, ...agg, dps, hps });
  }
  for (const [ownerId, agg] of byOwner) {
    if (seen.has(ownerId)) continue;
    const dps = agg.seconds > 0 ? agg.damage / agg.seconds : 0;
    const hps = agg.seconds > 0 ? agg.healing / agg.seconds : 0;
    out.push({ key: ownerId, ownerId, player: { playerId: ownerId, name: ownerId }, name: ownerId, seat: 99, ...agg, dps, hps });
  }
  return out.sort((a, b) => b.damage - a.damage || b.healing - a.healing || a.seat - b.seat);
}

/** A modeless panel: the battlefield stays visible and keeps playing. Mounted only while open. */
export function CombatMetricsPanel({ myId, onClose, runner = battleRunner, players: playersProp = null }) {
  const pub = useStore((s) => s.match?.public);
  const playerList = sortedPlayers(Array.isArray(playersProp) ? { players: playersProp } : pub);
  const showPlayers = playerList.length > 1;
  const defaultTarget = myId && playerList.some((p) => p.playerId === myId) ? myId : 'ALL';
  const [scope, setScope] = useState('battle');
  const [selectedId, setSelectedId] = useState(() => defaultTarget);
  const [allView, setAllView] = useState('players');
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  useTicker(250);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.querySelector('.modal, .guide')) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const corner = panel?.parentElement;
    const viewport = window.visualViewport;
    const measure = () => {
      if (!panel || !corner) return;
      const rect = corner.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const layout = combatMetricsLayout({
        cornerTop: rect.top, cornerBottom: rect.bottom,
        viewportHeight: viewport?.height || window.innerHeight,
        viewportTop: viewport?.offsetTop || 0,
        rem: parseFloat(rootStyle.fontSize) || 40,
        safeTop: parseFloat(rootStyle.getPropertyValue('--sa-t')) || 0,
        safeBottom: parseFloat(rootStyle.getPropertyValue('--sa-b')) || 0,
      });
      panel.style.setProperty('--combat-corner-height', `${rect.height || 44}px`);
      panel.style.setProperty('--combat-available-height', `${layout.availableHeight}px`);
      panel.style.setProperty('--combat-viewport-height', `${layout.viewportSpace}px`);
      panel.style.setProperty('--combat-viewport-top', `${layout.viewportPanelTop}px`);
      panel.dataset.viewportDocked = String(layout.viewportDocked);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (corner) observer?.observe(corner);
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, []);
  const activeTarget = !showPlayers
    ? (myId || null)
    : selectedId === 'ALL' || playerList.some((p) => p.playerId === selectedId)
      ? selectedId
      : defaultTarget;
  const queryOwner = !showPlayers ? (myId || null) : activeTarget === 'ALL' ? null : activeTarget;
  const isAllView = showPlayers && activeTarget === 'ALL';
  const showPlayerRows = isAllView && allView === 'players';
  const playerNames = new Map(playerList.map((p) => [p.playerId, p.name || t('博士')]));
  const result = ((showPlayers || myId) ? runner?.combatMetrics({ scope, ownerId: queryOwner }) : null) || { rows: [], damage: 0, healing: 0 };
  const displayRows = showPlayerRows ? summarizeByPlayer(result.rows, playerList) : result.rows;
  const maximum = Math.max(1, ...displayRows.map((r) => r.damage));
  return html`<section ref=${panelRef} id="combat-metrics-panel" class="combat-metrics brackets" role="dialog" aria-label=${t('作战统计')}
      onKeyDown=${(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}>
    <header class="combat-metrics__head">
      <div><span class="combat-metrics__micro">COMBAT ANALYSIS</span><h2>${t('作战统计')}</h2></div>
      <button ref=${closeRef} type="button" class="combat-metrics__close" aria-label=${t('关闭作战统计')} onClick=${onClose}><${Icon} name="close" /></button>
      <div class="combat-metrics__tools">
        <div class="combat-metrics__scopes" role="group" aria-label=${t('统计范围')}>
          ${[['battle', t('当前战斗')], ['match', t('本局累计')], ['last', t('上一场战斗')]].map(([id, label]) => html`<button type="button" key=${id}
            aria-pressed=${scope === id} onClick=${() => setScope(id)}>${label}</button>`)}
        </div>
      </div>
      ${showPlayers ? html`<div class="combat-metrics__players" role="group" aria-label=${t('统计对象')} data-testid="combat-metrics-players">
        ${playerList.map((p) => {
          const isSelf = p.playerId === myId;
          const active = activeTarget === p.playerId;
          return html`<button type="button" key=${p.playerId} class="combat-metrics__avatar"
              data-player-id=${p.playerId} aria-pressed=${active ? 'true' : 'false'}
              title=${isSelf ? `${p.name || t('博士')}（${t('你')}）` : (p.name || t('博士'))}
              aria-label=${p.name || t('博士')}
              onClick=${() => setSelectedId(p.playerId)}>
            <${PlayerAvatar} player=${p} size="sm" self=${isSelf} />
          </button>`;
        })}
        <button type="button" class="combat-metrics__avatar combat-metrics__avatar--all"
            data-testid="combat-metrics-all" aria-pressed=${activeTarget === 'ALL' ? 'true' : 'false'}
            title=${t('全队统计')} aria-label=${t('全队统计')}
            onClick=${() => setSelectedId('ALL')}>
          <span>ALL</span>
        </button>
        ${isAllView ? html`<div class="combat-metrics__allview" role="group" aria-label=${t('全队统计')} data-testid="combat-metrics-all-view">
          ${[['players', t('按玩家')], ['units', t('全干员')]].map(([id, label]) => html`<button type="button" key=${id}
            aria-pressed=${allView === id ? 'true' : 'false'} onClick=${() => setAllView(id)}>${label}</button>`)}
        </div>` : null}
      </div>` : null}
    </header>
    <div class="combat-metrics__body" tabindex="0">
    <div class="combat-metrics__totals">
      <span>${t('总伤害')} <b>${number(result.damage)}</b></span><span>${t('总治疗')} <b>${number(result.healing)}</b></span>
    </div>
    <div class="combat-metrics__legend" aria-label=${t('伤害类型图例')}>
      ${TYPES.map((type) => html`<span key=${type.id} class=${`combat-metrics__type combat-metrics__type--${type.id}`}>${t(type.label)}</span>`)}
      <span class="combat-metrics__sort">${t('伤害降序')}</span>
    </div>
    <ol class="combat-metrics__list" tabindex="0" aria-label=${showPlayerRows ? t('全队统计') : t('干员伤害排行')}>
      ${displayRows.length ? displayRows.map((r, i) => {
        const description = TYPES.map((type) => `${t(type.label)} ${number(r.types[type.id])}`).join('，');
        const ownerName = isAllView && !showPlayerRows ? playerNames.get(r.ownerId) : null;
        return html`<li key=${r.key} class="combat-metrics__row">
          <span class="combat-metrics__rank">${String(i + 1).padStart(2, '0')}</span>
          ${showPlayerRows
            ? html`<${PlayerAvatar} player=${r.player} size="sm" self=${r.ownerId === myId} />`
            : html`<${UnitThumb} kind=${r.kind === 'token' ? 'token' : 'chess'} id=${r.defId} ownerId=${r.ownerId}
                rec=${r.picture?.charId ? { ...r.picture, name: r.name } : null} showTier=${false} size="sm" />`}
          <div class="combat-metrics__unit">
            <div class="combat-metrics__name"><b title=${r.name || r.defId}>${showPlayerRows ? (r.name || t('博士')) : (r.name || r.defId)}</b>${ownerName ? html`<span class="combat-metrics__owner" title=${ownerName}>${ownerName}</span>` : null}</div>
            <div class="combat-metrics__bar" role="img" aria-label=${description} title=${description}>
              ${TYPES.map((t) => html`<span key=${t.id} class=${`combat-metrics__segment combat-metrics__segment--${t.id}`}
                style=${{ width: `${r.types[t.id] / maximum * 100}%` }}></span>`)}
            </div>
            <div class="combat-metrics__values">
              <span><small>${t('伤害')}</small><b>${number(r.damage)}</b></span>
              <span><small>DPS</small><b>${rate(r.dps)}</b></span>
              <span class="combat-metrics__heal"><small>${t('治疗')}</small><b>${number(r.healing)}</b></span>
              <span class="combat-metrics__heal"><small>HPS</small><b>${rate(r.hps)}</b></span>
            </div>
          </div>
        </li>`;
      }) : html`<li class="combat-metrics__empty">${scope === 'last' ? t('暂无上一场战斗记录') : t('暂无本地战斗记录')}<br /><small>${scope === 'last' ? t('打完一场战斗后显示') : t('开始战斗后实时显示干员数据')}</small></li>`}
    </ol>
    <p class="combat-metrics__note">${showPlayers
      ? html`${t('支持查看全队 · 同名干员合并 · 召唤物计入所属干员')}<br />${t('实际扣血 / 有效治疗，DPS / HPS 按对应玩家战斗秒数计算。队友数据在战斗结束后同步。')}`
      : html`${t('仅统计自己 · 同名干员合并 · 召唤物计入所属干员')}<br />${t('实际扣血 / 有效治疗，DPS / HPS 按自己的战斗秒数计算。刷新后重新累计。')}`}</p>
    </div>
  </section>`;
}
