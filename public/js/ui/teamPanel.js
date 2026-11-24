// Left team panel (research 06 §11.1, research 09 §3.1): one row per seat — avatar (band icon once picked), name, LP
// tower, status glyph (… acting / ✓ ready / ⌛ deciding / ⚔ combat / door left / ✕ dead), AI badge, "you" marker, the
// field being watched (eye badge), and emote bubbles. In a boss round the viewer's pair is framed in green from the
// round's start (gameLogic teamFrameIds; community report of 2026-10-06, item 51).
// Official unfolded team overview: tapping any player avatar unfolds the horizontal overview panel beside every seat,
// showing in order: player avatar (with 「前往观战」 / 「返回战场」 ribbons), name + shop level, active bonds,
// deployed lineup, and chosen strategy portrait. Tapping 「前往观战」 watches that teammate; tapping 「返回战场」
// returns to your own battlefield. In PHASE.PREP a double-click on a teammate's avatar still opens their field directly
// (GitHub #131). Without `observe` (server-run combat) clicking a teammate still watches at once.
// Live LP (user playtest #3 item 2): during a normal round's battle each row's tower shows lp − the loss that player's
// leaks so far will cost (red, −N): the own row the top bar's live value (`self`, ui/hud.js liveLp), a teammate's row
// m.public players[].pendingLp (server/match/match/views.js, ~1 Hz). 联防 (user playtest #6 item 7): a leaker's row adds the
// runner tag ×N — its enemies still standing on the 联防 field, uncapped and live — next to lp − min(lpCapPerRound, N).
// 完美连胜 / 领袖伤害 (DESIGN §37.148, every version; ui/avatarBadges.js): the streak badge on the avatar's top-right corner
// (the own row's "you" marker moves to the bottom-left corner while it shows), the leader-damage scan over the avatar
// during a leader fight; `badges` = { pack, still } (the theme's avatar prefabs, else ac_n_initial's; null pack: CSS).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Icon, Tooltip } from './components.js';
import { PlayerAvatar, LpTower, GIcon, LocalSprite, BondGlyph, UnitThumb, Img, RichTip, RichText } from './gameComponents.js';
import { EmoteBubble } from './emotes.js';
import { STATUS_META, sortedPlayers, teamFrameIds, bondTier, diyRecordFor, cardStandIn, standInForText } from './gameLogic.js';
import { bondEffectRecord } from './bondEffect.js';
import { bandIconUrl } from './assetUrls.js';
import { MissTag, uniteRemaining } from './hud.js';
import { WinStreakBadge, BossDamageBadge, avatarBadgeTips } from './avatarBadges.js';
import { data, localAsset } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

/** Official status glyphs (ui/battle) per m.public players[].status; CSS glyph fallback. */
const STATUS_SPRITE = { ready: 'icon_ready', deciding: 'icon_waiting', done: 'icon_complete', dead: 'icon_dead' };

/**
 * A row's LP tower: the settled LP and the pending loss of the round's battle (0 outside COMBAT / UNITE). The own row
 * takes the top bar's live value when there is one (its m.private lp: the same number as the top bar). `left`: during
 * 联防 a leaker's enemies still standing (the ×N tag), else null.
 * @param {any} p m.public players[] entry @param {any} pub m.public
 * @param {{ lp?: number|null, pending: number, unite: boolean, left?: number|null } | null} [self] the own live value (only for the own row)
 * @param {{ uniteLocal?: Record<string, number> | null, cap?: number }} [opts]
 * @returns {{ lp: number|null, pending: number, unite: boolean, left: number|null }}
 */
export function rowLp(p, pub, self = null, { uniteLocal = null, cap = 10 } = {}) {
  const pubLp = Number.isFinite(p?.lp) ? p.lp : null;
  if ((pub?.phase !== PHASE.COMBAT && pub?.phase !== PHASE.UNITE) || p?.alive === false) return { lp: pubLp, pending: 0, unite: false, left: null };
  const lp = self && Number.isFinite(self.lp) ? self.lp : pubLp;
  const leaker = pub.phase === PHASE.UNITE && Array.isArray(pub.unite?.leakers) && pub.unite.leakers.includes(p.playerId);
  const local = !self && leaker && uniteLocal && typeof uniteLocal === 'object' ? uniteRemaining(uniteLocal[p.playerId] ?? 0, null) : null;
  const rawLeft = pub.phase !== PHASE.UNITE ? null : self ? self.left : local != null ? local : p.uniteLeft;
  const left = Number.isFinite(rawLeft) && rawLeft >= 0 ? Math.trunc(rawLeft) : null;
  if (lp == null) return { lp, pending: 0, unite: false, left };
  const raw = self ? self.pending : local != null ? Math.min(cap, local) : p.pendingLp;
  const pending = Math.min(lp, Math.max(0, Math.trunc(Number(raw) || 0)));
  return { lp, pending, unite: (pending > 0 || left != null) && (self ? !!self.unite : pub.phase === PHASE.UNITE), left };
}

/** True when `watching` is already this teammate's field (their live field, or the prep scout `n:<id>`). */
export function teammateFieldShown(watching, player) {
  if (!watching || !player) return false;
  return watching === player.fieldId || watching === `n:${player.playerId}`;
}

/**
 * A single click on a teammate avatar calls onWatch only in server-run combat (no `observe`), and only when
 * that field is not already on screen.
 * @param {{ observe?: unknown, watching?: string|null, player?: { playerId?: string, fieldId?: string }|null, askedRecently?: boolean }} [o]
 * @returns {boolean}
 */
export function teammateClickWatches(o = {}) {
  if (o.observe || o.askedRecently) return false;
  if (teammateFieldShown(o.watching, o.player)) return false;
  return !!o.player;
}

/**
 * Double-click in PHASE.PREP opens a teammate's field directly. False when the phase is not PREP, the row is your own,
 * there is no client-combat `observe`, `canObserve` has no field, or that field is already open.
 * @param {{ phase?: string, self?: boolean, observe?: { canObserve?: (p: any) => { fieldId?: string }|null }|null,
 *   watching?: string|null, player?: any, askedRecently?: boolean }} [o]
 * @returns {boolean}
 */
export function prepDblClickWatches(o = {}) {
  if (o.phase !== PHASE.PREP || o.self || !o.player || !o.observe) return false;
  if (o.askedRecently || teammateFieldShown(o.watching, o.player)) return false;
  const view = (typeof o.observe.canObserve === 'function' ? o.observe.canObserve(o.player) : null) || {};
  return !!view.fieldId;
}

/** Active bonds of one player for the overview row, sorted by visible layers descending (noStack last without count). */
export function overviewBonds(p, { self = false, priv = null, bondRec = (id) => data.lookup('bonds', id) } = {}) {
  const raw = (self && Array.isArray(priv?.bonds) && priv.bonds.length ? priv.bonds : p?.bonds) || [];
  const list = raw
    .filter((b) => b && typeof b.bondId === 'string' && b.active && !b.off)
    .map((b) => {
      const rec = bondRec(b.bondId);
      const hideLayers = !!rec?.noStack;
      return { ...b, hideLayers, _sort: hideLayers ? -1 : Number(b.layers) || 0 };
    });
  list.sort((a, b) => b._sort - a._sort || a.bondId.localeCompare(b.bondId));
  return list;
}

/** Deployed lineup of one player for the overview row (`pub.players[].lineup`, or own `priv.board` fallback). */
export function overviewLineup(p, { self = false, priv = null } = {}) {
  if (Array.isArray(p?.lineup) && p.lineup.length) return p.lineup;
  if (self && Array.isArray(priv?.board)) {
    return priv.board
      .filter((u) => u && u.kind !== 'token' && typeof u.id === 'string')
      .map((u) => ({
        id: u.id,
        kind: u.kind || 'chess',
        golden: !!u.golden,
        tier: u.tier,
        items: Array.isArray(u.items) ? u.items.map((it) => (typeof it === 'string' ? it : it?.id)).filter(Boolean) : [],
        skin: u.skin || null,
        diy: u.diy || null,
        standInFor: u.standInFor || null,
      }));
  }
  return [];
}

/**
 * Which avatar action ribbon shows when the team overview is unfolded:
 * - `'back'` (`返回战场`) on your own row while observing a teammate,
 * - `'watch'` (`前往观战`) on an observable teammate not currently watched,
 * - `'watching'` on the teammate currently being watched,
 * - `null` otherwise.
 */
export function avatarRibbon(p, { self = false, observe = null, watched = false } = {}) {
  if (!observe || !p) return null;
  if (self) return observe.observing ? 'back' : null;
  if (watched) return 'watching';
  const view = (typeof observe.canObserve === 'function' ? observe.canObserve(p) : null) || {};
  return view.fieldId ? 'watch' : null;
}

/** How long the second click of a double-click counts as "already asked" before `watching` re-renders. */
const AVATAR_CLICK_GAP_MS = 500;

/**
 * Tooltip of a row's LP tower with a pending loss (null without one).
 * @param {{ lp: number|null, pending: number, unite: boolean, left: number|null } | null} lp rowLp(...)
 * @param {number} [cap] lpCapPerRound
 */
export function rowLpTip(lp, cap = 10) {
  if (!lp || !(lp.pending > 0)) return null;
  if (lp.unite && lp.left != null) return t('目标生命值 {lp}，联防中：漏过的敌人还剩 {left} 个，按现在结算扣除 {pending} 点（每回合至多 {cap} 点）', { lp: lp.lp, left: lp.left, pending: lp.pending, cap });
  return lp.unite ? t('目标生命值 {lp}，联防中，结算时扣除至多 {pending} 点', { lp: lp.lp, pending: lp.pending })
    : t('目标生命值 {lp}，结算时扣除 {pending} 点', { lp: lp.lp, pending: lp.pending });
}

function OverviewUnitThumb({ u, gd, ownerId, onSelect }) {
  const chess = u.kind === 'token' ? null : (gd?.chess ? gd.chess(u.id) : data.lookup('chess', u.id));
  const dr = u.diy && chess ? diyRecordFor(chess, u.diy, { chess: data.get('chess'), backups: data.get('backups') }) : null;
  const si = !dr && chess ? cardStandIn(chess, { unit: u, backups: gd?.backups ?? data.get('backups') }) : null;
  const label = (dr || si || chess)?.name || u.id;
  const title = si ? t('{name}（{note}）', { name: si.name, note: standInForText(chess.name) }) : label;
  return html`<button type="button" class="team-ov__unit" title=${title} aria-label=${label}
      onClick=${(e) => { e.stopPropagation(); onSelect?.(u); }}>
    <${UnitThumb} kind=${u.kind === 'token' ? 'token' : 'chess'} id=${u.id} ownerId=${ownerId} skin=${u.skin}
      golden=${!!u.golden} tier=${u.tier} size="sm" rec=${dr || si} title=${title} />
  </button>`;
}

/**
 * @param {{ pub:any, priv?:any, gd?:any, myId:string, watching:string|null, bubbles: Map<string,{id:string,seq:number}>,
 *   onWatch:(p:any)=>void, onBond?:(bondId:string, ownerId:string)=>void, onChess?:(u:any, p:any)=>void,
 *   onOverviewChange?:(open:boolean)=>void,
 *   compact?: boolean, self?: { lp?: number|null, pending: number, unite: boolean, left?: number|null } | null,
 *   cap?: number, uniteLocal?: Record<string, number> | null, spMarks?: Map<string, string>|null,
 *   observe?: null | { canObserve: (p:any) => { fieldId?: string, reason?: string|null, back?: boolean }, observing: boolean, onBack: () => void },
 *   badges?: { pack: any, still?: boolean } | null }} props
 */
export function TeamPanel({ pub, priv = null, gd = null, myId, watching, bubbles, onWatch, onBond = null, onChess = null, onOverviewChange = null, compact = false, observe = null, self: selfLive = null, cap = 10, uniteLocal = null, spMarks = null, badges = null }) {
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [bandTipPid, setBandTipPid] = useState(null);
  // the playerId whose avatar just called onWatch, so the other click of a double-click does not open the view again
  const askedAt = useRef(/** @type {{ id: string|null, at: number }} */ ({ id: null, at: 0 }));
  const phaseKey = `${pub?.phase}:${pub?.round}`;
  useEffect(() => { setOverviewOpen(false); setBandTipPid(null); }, [phaseKey, watching, observe?.observing]);
  useEffect(() => {
    onOverviewChange?.(overviewOpen);
    return () => { if (overviewOpen) onOverviewChange?.(false); };
  }, [overviewOpen]);
  useEffect(() => {
    if (!overviewOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.bpop, .dpanel')) { setOverviewOpen(false); setBandTipPid(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overviewOpen]);

  const players = sortedPlayers(pub);
  if (!players.length) return null;
  // a boss round: the viewer's pair framed in green from the round's start
  const team = teamFrameIds(pub, myId);
  const frameArt = team.size ? localAsset('ui/battle', 'bg_team_border') : null;
  const askedRecently = (p) => askedAt.current.id === p?.playerId && Date.now() - askedAt.current.at < AVATAR_CLICK_GAP_MS;
  const noteAsked = (p) => { askedAt.current = { id: p.playerId, at: Date.now() }; };
  const closeOverview = () => { setOverviewOpen(false); setBandTipPid(null); };

  const watchSeat = (p) => {
    closeOverview();
    if (!askedRecently(p)) { noteAsked(p); onWatch(p); }
  };

  const click = (p, self) => {
    if (!observe) {
      if (self || teammateClickWatches({ watching, player: p, askedRecently: askedRecently(p) })) {
        if (!self) noteAsked(p);
        onWatch(p);
      }
      return;
    }
    if (!overviewOpen) {
      setOverviewOpen(true);
      return;
    }
    if (self) {
      if (observe.observing) { closeOverview(); observe.onBack(); }
      else closeOverview();
      return;
    }
    const watched = teammateFieldShown(watching, p);
    if (watched) { closeOverview(); return; }
    watchSeat(p);
  };

  const dblClick = (e, p, self) => {
    if (!prepDblClickWatches({ phase: pub?.phase, self, observe, watching, player: p, askedRecently: askedRecently(p) })) return;
    e.preventDefault();
    closeOverview();
    noteAsked(p);
    onWatch(p);
  };

  const assets = data.get('assets');

  return html`<aside class=${cx('team', compact && 'team--compact', overviewOpen && 'is-overview')} aria-label=${t('同盟成员')} data-overview=${overviewOpen ? 'open' : 'closed'}>
    ${overviewOpen ? html`<div class="team-ov__backdrop" onClick=${closeOverview} aria-hidden="true"></div>` : null}
    <div class="team-ov__shell">
      <div class="team-ov__rows">
        ${players.map((p) => {
          const self = p.playerId === myId;
          const status = p.alive === false ? 'dead' : p.status;
          const meta = STATUS_META[status] || STATUS_META.acting;
          const watched = teammateFieldShown(watching, p);
          const bubble = bubbles?.get(p.playerId);
          const offline = p.connected === false && !p.isBot;
          const ribbon = overviewOpen ? avatarRibbon(p, { self, observe, watched }) : null;
          const backCollapsed = !overviewOpen && !!observe && self && observe.observing;
          const title = observe ? (self ? (observe.observing ? t('返回战场') : t('队友总览')) : t('查看 {name} 的战场', { name: p.name })) : (self ? t('查看自己的阵地') : t('查看 {name} 的阵地', { name: p.name }));
          const lp = rowLp(p, pub, self ? selfLive : null, { uniteLocal, cap });
          const inTeam = team.has(p.playerId);
          const streakLevel = p.alive === false ? 0 : Math.trunc(Number(p.winStreakLevel) || 0);
          const damageLevel = p.alive === false ? 0 : Math.trunc(Number(p.bossDamageLevel) || 0);
          const tip = [inTeam && !self ? `${title} · ${t('与你在同一战场')}` : title, ...avatarBadgeTips(p)].join('\n');
          const shopLv = Math.max(1, Math.min(6, Math.trunc(Number(p.shopLevel) || 1)));
          const bonds = overviewOpen ? overviewBonds(p, { self, priv }) : [];
          const lineup = overviewOpen ? overviewLineup(p, { self, priv }) : [];
          const band = overviewOpen && p.bandId ? (gd?.band ? gd.band(p.bandId) : data.lookup('bands', p.bandId)) : null;
          const bandImg = overviewOpen && p.bandId ? bandIconUrl(assets, p.bandId) : null;
          const bandOpen = overviewOpen && bandTipPid === p.playerId && !!band;
          return html`<div key=${p.playerId} class=${cx('team__row', self && 'is-self', inTeam && 'is-team', watched && 'is-watched', p.alive === false && 'is-dead', overviewOpen && 'is-open')}>
            <div class="team__avatar-wrap">
              <button type="button" class="team__btn" onClick=${() => click(p, self)} onDblClick=${(e) => dblClick(e, p, self)} title=${tip} aria-expanded=${observe ? String(overviewOpen) : undefined}>
                <${PlayerAvatar} player=${p} self=${self} />
                ${damageLevel > 0 ? html`<${BossDamageBadge} pack=${badges?.pack || null} level=${damageLevel} still=${!!badges?.still} />` : null}
                ${inTeam ? html`<span class=${cx('team__frame', !frameArt && 'team__frame--plain')} style=${frameArt ? `--frame:url("${frameArt}")` : undefined} aria-hidden="true"></span>` : null}
                <span class="team__seat num">P${(p.seat ?? 0) + 1}</span>
                ${p.isBot ? html`<span class="team__ai">AI</span>` : null}
                ${self ? html`<span class=${cx('team__you', streakLevel > 0 && 'is-low')}><${Icon} name="user" /></span>` : null}
                ${streakLevel > 0 ? html`<${WinStreakBadge} pack=${badges?.pack || null} level=${streakLevel} streak=${p.winStreak} still=${!!badges?.still} />` : null}
                ${spMarks?.get(p.playerId) === 'done' ? html`<span class="team__spmark is-done" title=${t('已完成选择')}><${Icon} name="check" /></span>`
                  : spMarks?.get(p.playerId) === 'turn' ? html`<span class="team__spmark is-turn" title=${t('正在决策…')}><i></i><i></i><i></i></span>` : null}
              </button>
              ${ribbon === 'watch' ? html`<button type="button" class="team__ob team__ribbon"
                onClick=${(e) => { e.stopPropagation(); watchSeat(p); }}><${Icon} name="chevronLeft" class="team__ribbon-icon" /><span class="btn__label">${t('前往观战')}</span></button>` : null}
              ${ribbon === 'back' ? html`<button type="button" class="team__back team__ribbon"
                onClick=${(e) => { e.stopPropagation(); closeOverview(); observe.onBack(); }}><span class="btn__label">${t('返回战场')}</span></button>` : null}
              ${ribbon === 'watching' ? html`<span class="team__ribbon team__ribbon--watching">${t('观战中')}</span>` : null}
            </div>
            ${overviewOpen ? html`
              <div class="team-ov__who">
                <div class="team-ov__name-row">
                  <span class="team__name">${p.name || t('博士')}</span>
                  ${self ? html`<span class="team-ov__tag is-self">${t('你')}</span>` : null}
                  ${p.isBot ? html`<span class="team-ov__tag is-ai">AI</span>` : null}
                  <${Tooltip} text=${offline ? t('连接已断开') : t(meta.text)} placement="right">
                    <span class=${cx('team__status', 'team-ov__status', `is-${meta.tone}`, offline && 'is-offline', (offline || STATUS_SPRITE[status]) && localAsset('ui/battle', offline ? 'icon_lost_connect' : STATUS_SPRITE[status]) && 'has-sprite')} aria-label=${t(meta.text)}>
                      ${offline ? html`<${LocalSprite} name="icon_lost_connect" fallback=${html`<${Icon} name="wifiOff" />`} />`
                        : STATUS_SPRITE[status] ? html`<${LocalSprite} name=${STATUS_SPRITE[status]} fallback=${html`<${GIcon} name=${meta.glyph} />`} />`
                        : html`<${GIcon} name=${meta.glyph} />`}
                    </span>
                  <//>
                </div>
                <div class="team-ov__meta-row">
                  <span class=${cx('team-ov__lv', `is-lv${shopLv}`, p.alive === false && 'is-dead')} title=${p.alive === false ? t('已淘汰') : t('调度中心 Lv.{n}', { n: shopLv })}>
                    ${p.alive === false ? t('已淘汰') : html`<small>LV</small><b class="num">${ROMAN[shopLv - 1]}</b>`}
                  </span>
                  <${LpTower} value=${lp.lp} size="sm" tone=${Number.isFinite(lp.lp) && lp.lp - lp.pending <= 5 ? 'danger' : null} pending=${lp.pending}
                    tip=${rowLpTip(lp, cap)} />
                  ${lp.left != null ? html`<${MissTag} n=${lp.left} name=${self ? null : p.name || t('博士')} />` : null}
                </div>
              </div>
              <div class="team-ov__bonds" role="list" aria-label=${t('盟约')}>
                ${bonds.length ? bonds.map((b) => {
                  const base = data.lookup('bonds', b.bondId);
                  const rec = bondEffectRecord(base, data.lookup('effects', b.effectId || base?.effectId), b.layers ?? 0);
                  const th = b.effectId ? rec?.thresholds || [] : Array.isArray(b.thresholds) && b.thresholds.length ? b.thresholds : rec?.thresholds || [];
                  const tier = bondTier(b.count ?? 0, th) || 1;
                  const bName = rec?.name || base?.name || b.bondId;
                  const core = base?.kind === 'core';
                  return html`<button type="button" key=${b.bondId} role="listitem"
                    class=${cx('team-ov__bond', core ? 'is-core' : 'is-addon', `is-t${Math.min(3, tier)}`)}
                    title=${b.hideLayers ? bName : `${bName} · ${b.layers ?? 0}`}
                    onClick=${() => { if (onBond) onBond(b.bondId, p.playerId); }}>
                    <span class="team-ov__bdisc"><${BondGlyph} bondId=${b.bondId} /></span>
                    ${b.hideLayers ? null : html`<span class="team-ov__blayer num">${b.layers ?? 0}</span>`}
                    <span class="team-ov__bname">${bName}</span>
                  </button>`;
                }) : html`<span class="team-ov__empty">${t('暂无已激活盟约')}</span>`}
              </div>
              <div class="team-ov__lineup" aria-label=${t('已放置队伍')}>
                ${lineup.length ? lineup.map((u, i) => html`<${OverviewUnitThumb} key=${`${u.id}:${i}`} u=${u} gd=${gd} ownerId=${p.playerId} onSelect=${(unit) => onChess?.(unit, p)} />`)
                  : html`<span class="team-ov__empty">${t('暂无上阵干员')}</span>`}
              </div>
              <div class="team-ov__band">
                ${band ? html`<${RichTip} text=${`${band.name}\n${band.desc || ''}`} placement="left">
                  <button type="button" class=${cx('team-ov__bandbtn', bandOpen && 'is-open')} aria-label=${band.name}
                    onClick=${() => setBandTipPid((cur) => (cur === p.playerId ? null : p.playerId))}>
                    <${Img} src=${bandImg} class="team-ov__bandimg" fallback=${html`<span class="team-ov__bandtxt">${[...(band.name || '?')][0]}</span>`} />
                    <span class="team-ov__bandmag" aria-hidden="true"><${Icon} name="search" /></span>
                  </button>
                <//>` : html`<span class="team-ov__bandbtn is-empty" title=${t('暂未选择策略')}>—</span>`}
                ${bandOpen ? html`<div class="team-ov__bandpop" role="dialog" aria-label=${band.name}>
                  <div class="team-ov__bandpop-head"><b>${band.name}</b><button type="button" onClick=${() => setBandTipPid(null)} aria-label=${t('关闭')}><${Icon} name="close" /></button></div>
                  <div class="team-ov__bandpop-body"><${RichText} text=${band.desc || ''} /></div>
                </div>` : null}
              </div>
            ` : html`<div class="team__info">
              <span class="team__name">${p.name || t('博士')}</span>
              <div class="team__line">
                <${LpTower} value=${lp.lp} size="sm" tone=${Number.isFinite(lp.lp) && lp.lp - lp.pending <= 5 ? 'danger' : null} pending=${lp.pending}
                  tip=${rowLpTip(lp, cap)} />
                ${lp.left != null ? html`<${MissTag} n=${lp.left} name=${self ? null : p.name || t('博士')} />` : null}
                <${Tooltip} text=${offline ? t('连接已断开') : t(meta.text)} placement="right">
                  <span class=${cx('team__status', `is-${meta.tone}`, offline && 'is-offline', (offline || STATUS_SPRITE[status]) && localAsset('ui/battle', offline ? 'icon_lost_connect' : STATUS_SPRITE[status]) && 'has-sprite')} aria-label=${t(meta.text)}>
                    ${offline ? html`<${LocalSprite} name="icon_lost_connect" fallback=${html`<${Icon} name="wifiOff" />`} />`
                      : STATUS_SPRITE[status] ? html`<${LocalSprite} name=${STATUS_SPRITE[status]} fallback=${html`<${GIcon} name=${meta.glyph} />`} />`
                      : html`<${GIcon} name=${meta.glyph} />`}
                  </span>
                <//>
                ${watched && !self ? html`<span class="team__eye" title=${t('正在查看')}><${GIcon} name="eye" /></span>` : null}
              </div>
              ${backCollapsed ? html`<button type="button" class="btn btn--secondary btn--sm team__back"
                onClick=${() => observe.onBack()}><span class="btn__label">${t('返回战场')}</span></button>` : null}
            </div>`}
            ${bubble ? html`<${EmoteBubble} key=${bubble.seq} id=${bubble.id} class="team__bubble" />` : null}
          </div>`;
        })}
      </div>
      ${overviewOpen ? html`<button type="button" class="team-ov__close" onClick=${closeOverview} aria-label=${t('收起')} title=${t('收起')}>
        <${Icon} name="chevronLeft" />
      </button>` : null}
    </div>
  </aside>`;
}
