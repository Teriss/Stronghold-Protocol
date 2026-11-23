import { useState } from '../../vendor/hooks.module.js';
import { t } from '../../../shared/i18n.js';
import { net } from '../net.js';
import { useStore } from '../store.js';
import { Button, Countdown, Modal, html } from './components.js';
import { toastError } from './toasts.js';

export function EndlessVote({ pub }) {
  const myId = useStore((s) => s.me.playerId);
  const online = useStore((s) => s.connection.status === 'online');
  const [pending, setPending] = useState(false);
  const { vote, cycle } = pub.endless;
  const names = new Map(pub.players.map((p) => [p.playerId, p.name]));
  const canVote = vote.voters.includes(myId);
  const voted = vote.agreed.includes(myId);

  const send = async (agree) => {
    if (!online || pending) return;
    setPending(true);
    try { await net.request('g.endlessVote', { cycle, agree }); }
    catch (err) { toastError(err); }
    finally { setPending(false); }
  };

  const title = t('第 {n} 轮已通关', { n: cycle });
  const desc = t('全员同意后更换地图、复活队友，敌方生命值和攻击力升至基准的 {n} 倍。', {
    n: vote.nextMultiplier.toLocaleString(undefined, { maximumFractionDigits: 2 })
  });

  const playersList = html`<div class="vervote__players endless-vote__players" aria-live="polite">
    ${vote.voters.map((id) => html`<span key=${id} class=${vote.agreed.includes(id) ? 'is-agreed' : ''}>
      ${names.get(id) || t('博士')} · ${t(vote.agreed.includes(id) ? '已同意' : '待同意')}
    </span>`)}
  </div>`;

  // 旁观者：无投票权（!canVote），不使用全屏模态弹窗以避免遮挡观战界面；展示悬浮票况，可继续使用观战控件
  if (!canVote) {
    return html`<aside class="endless-vote endless-vote--spectator brackets" data-testid="endless-vote" aria-label=${title}>
      <header class="endless-vote__head">
        <strong class="endless-vote__title">${title}</strong>
        <${Countdown} deadline=${pub.deadline} label=${t('续轮投票')} size="sm" gauge=${false} />
      </header>
      <p class="endless-vote__desc">${desc}</p>
      ${playersList}
    </aside>`;
  }

  // 有投票权的玩家（含名单内的淘汰队员）：接入 Modal 弹窗层，复用遮罩、层级与焦点管理
  const actions = html`
    <${Button} variant="secondary" disabled=${!online || pending} onClick=${() => send(false)}>${t('结束模拟')}<//>
    <${Button} variant="primary" disabled=${!online || pending || voted} onClick=${() => send(true)}>${t(voted ? '已同意' : '继续下一轮')}<//>
  `;

  return html`<${Modal}
    open=${true}
    title=${title}
    micro="ENDLESS VOTE"
    tone="mint"
    class="endless-vote endless-vote--modal"
    closeOnBackdrop=${false}
    onClose=${() => { /* 点击遮罩或 Esc 维持当前状态 */ }}
    actions=${actions}
    data-testid="endless-vote"
  >
    <div class="endless-vote__content">
      <div class="endless-vote__countdown">
        <${Countdown} deadline=${pub.deadline} label=${t('续轮投票')} size="sm" gauge=${false} />
      </div>
      <p class="endless-vote__desc">${desc}</p>
      ${playersList}
    </div>
  <//>`;
}
