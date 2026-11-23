import { useState } from 'preact/hooks';
import { Button, html, Icon, Modal } from './components.js';
import { BondPopup, BondStrip } from './bondStrip.js';
import { t } from '../../../shared/i18n.js';
import { LineupThumb } from '../screens/result.js';

export function TeamOverview({ pub, myId, gd }) {
  const [open, setOpen] = useState(false);
  const [bond, setBond] = useState(null);
  const players = (pub?.players || []).filter((p) => p.playerId !== myId);
  const owner = bond && players.find((p) => p.playerId === bond.playerId);
  const entry = owner?.bonds?.find((b) => b.bondId === bond.id && b.active && !b.off);
  const close = () => { setBond(null); setOpen(false); };
  const dismiss = () => { if (entry) setBond(null); else close(); };

  return html`
    <button type="button" class="gm__gear team-overview__toggle" aria-label=${t('队友总览')} title=${t('队友总览')}
      aria-haspopup="dialog" aria-expanded=${open} onClick=${() => setOpen(true)}><${Icon} name="users" /></button>
    <${Modal} open=${open} title=${t('队友总览')} onClose=${dismiss} class="team-overview" width="min(960px, 94vw)"
      actions=${html`<${Button} variant="secondary" onClick=${close}>${t('关闭')}<//>`}>
      <div class="team-overview__list">
        ${players.length === 0 ? html`<p class="t-lo">${t('当前没有队友')}</p>` : null}
        ${players.map((p) => {
          const lineup = p.lineup || [];
          const bonds = (p.bonds || []).filter((b) => b.active && !b.off);
          return html`<section key=${p.playerId} class="team-overview__player">
            <header class="team-overview__head">
              <b class="num">P${p.seat + 1}</b><span>${p.name}</span>
              ${p.isBot ? html`<small>AI</small>` : null}
              <span class="team-overview__level">${p.alive === false ? t('已淘汰') : t('调度中心 Lv.{n}', { n: p.shopLevel ?? 1 })}</span>
            </header>
            ${lineup.length ? html`<div class="team-overview__lineup">
              ${lineup.map((u, i) => html`<${LineupThumb} key=${i} u=${u} gd=${gd} ownerId=${p.playerId} />`)}
            </div>` : html`<p class="team-overview__empty">${t('暂无上阵干员')}</p>`}
            ${bonds.length ? html`<${BondStrip} bonds=${bonds} openId=${owner === p ? entry?.bondId : null}
              onOpen=${(id) => setBond((v) => v?.id === id && v.playerId === p.playerId ? null : { id, playerId: p.playerId })} />`
              : html`<p class="team-overview__empty">${t('暂无已激活盟约')}</p>`}
            ${owner === p && entry ? html`<div class="team-overview__bond">
              <${BondPopup} bondId=${entry.bondId} entry=${entry} priv=${{ board: lineup }} banned=${pub.disabledBonds || []}
                owner=${p.name} ownerId=${p.playerId} onClose=${() => setBond(null)} />
            </div>` : null}
          </section>`;
        })}
      </div>
    <//>`;
}
