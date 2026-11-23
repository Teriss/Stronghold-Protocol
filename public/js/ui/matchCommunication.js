import { useEffect, useRef, useState } from 'preact/hooks';
import { CHAT_MAX_CHARS, chatText } from '../../../shared/chat.js';
import { html } from './components.js';
import { EmoteWheel } from './emotes.js';
import { actions } from './gameActions.js';
import { t } from '../../../shared/i18n.js';
import { net } from '../net.js';
import { useStore } from '../store.js';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function MatchCommunication({ ended }) {
  const chat = useStore((s) => s.chat);
  const myId = useStore((s) => s.me.playerId);
  const online = useStore((s) => s.connection.status === 'online');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('emotes');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [readSeq, setReadSeq] = useState(0);
  const [stick, setStick] = useState(true);
  const list = useRef(null);
  const composing = useRef(false);
  const pending = useRef(false);
  const messages = chat?.messages || [];
  const last = messages.at(-1)?.seq || 0;
  const showChat = ended || tab === 'chat';

  useEffect(() => {
    if (!open || !showChat) return;
    setReadSeq(last);
    if (list.current && stick) list.current.scrollTop = list.current.scrollHeight;
  }, [last, open, showChat, stick]);

  const send = async (event) => {
    event.preventDefault();
    const text = chatText(draft);
    if (!text || composing.current || pending.current || !online || ended || !chat) return;
    pending.current = true;
    setSending(true);
    setError('');
    try {
      await net.request('g.chat', { matchId: chat.id, text });
      setDraft((current) => current === draft ? '' : current);
      setStick(true);
    } catch (err) {
      setError(err?.code === 'RATE' ? t('发送过快，请稍后再试') : t('消息发送失败，请重试'));
    } finally {
      pending.current = false;
      setSending(false);
    }
  };

  const unread = !open || !showChat ? messages.filter((m) => m.seq > readSeq && m.playerId !== myId).length : 0;
  const panel = html`<section class="match-chat" aria-label=${t('同盟聊天')}>
    <ol class="match-chat__messages" ref=${list} aria-live="polite" onScroll=${(event) => {
      const el = event.currentTarget;
      setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    }}>
      ${messages.length === 0 ? html`<li class="match-chat__empty">${t('暂无消息')}</li>` : null}
      ${messages.map((line) => html`<li key=${line.seq} class="match-chat__line">
        <div class="match-chat__meta"><b>${line.name}</b><time>${timeFormat.format(line.at)}</time></div>
        <div dir="auto">${line.text}</div>
      </li>`)}
    </ol>
    ${ended ? html`<p class="match-chat__note">${t('对局已结束')}</p>` : html`<form class="match-chat__form" onSubmit=${send}>
      <input type="text" value=${draft} maxLength=${CHAT_MAX_CHARS * 2} autocomplete="off"
        aria-label=${t('聊天消息')} placeholder=${t('输入消息')}
        onInput=${(event) => setDraft(event.currentTarget.value)}
        onCompositionStart=${() => { composing.current = true; }}
        onCompositionEnd=${() => { composing.current = false; }}
        onKeyDown=${(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && (event.isComposing || composing.current || event.keyCode === 229)) event.preventDefault();
          if (event.key === 'Escape' && !composing.current) setOpen(false);
        }} />
      <button type="submit" disabled=${sending || !online || !chatText(draft)}>${t('发送')}</button>
    </form>`}
    ${error ? html`<div class="match-chat__error" role="status">${error}</div>` : null}
  </section>`;
  return html`<${EmoteWheel} open=${open} onToggle=${setOpen} onSend=${actions.emote} disabled=${!online}
    chat=${panel} chatOpen=${showChat} onTab=${setTab} chatOnly=${ended} unread=${unread} />`;
}
