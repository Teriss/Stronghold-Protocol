import { useState } from '../../../vendor/hooks.module.js';
import { html, Button } from '../../../js/ui/components.js';
import { t } from '../../../../shared/i18n.js';
import { CUSTOM_EMOTE_SLOTS_PER_PACK, makeCustomEmoteId } from '../../../../shared/constants.js';
import { data, useData } from '../../../js/data.js';
import { EmoteBubble } from '../../../js/ui/emotes.js';
import { EMOTE_PACKS_MAX, presentationOptions } from '../presentation.js';
import { fileBase64 } from '../api.js';
import { Line, Upload, SaveMediaNote, PresentationIssues } from './presentationControls.js';
import art from './art.js';

export function EmotesEditor({ draft, onChange, onFiles, onClear, dirty, busy }) {
  useData('assets');
  const o = presentationOptions('emotes', draft.options);
  const [bubble, setBubble] = useState(null);
  const manifestEmotes = data.get('assets')?.emotes || {};
  const change = (packs) => onChange({ ...draft, options: { ...o, packs } });
  const editPack = (pi, patch) => change(o.packs.map((pack, i) => (i === pi ? { ...pack, ...patch } : pack)));
  const editSlot = (pi, si, patch) => editPack(pi, {
    slots: (o.packs[pi]?.slots || []).map((slot, j) => (j === si ? { ...slot, ...patch } : slot)),
  });
  const upload = (slot, files) => Promise.all(files.map(async (file) => ({ name: file.name, data: await fileBase64(file) }))).then((list) => onFiles(slot, list));

  return html`<div class="st-form" data-testid="emotes-editor">
    <p class="st-note">${t('每套表情包对应局内交流面板的一页，最多 6 个表情格；主题键与槽位键仅允许小写字母、数字及 _ -，最长 32 字符。房间启用本插件后，全员可同步看到发出的自定义表情。')}</p>
    <${SaveMediaNote} dirty=${dirty} />
    ${o.packs.map((pack, pi) => {
      const slots = Array.isArray(pack.slots) ? pack.slots : [];
      const liveSlots = manifestEmotes[pack.key]?.slots || {};
      return html`<fieldset class="st-presentation-row" key=${pi}>
        <legend>${pack.name || pack.key}</legend>
        <${Line} label=${t('主题键')} value=${pack.key} onChange=${(key) => editPack(pi, { key })} />
        <${Line} label=${t('主题名称')} value=${pack.name} maxLength=${64} onChange=${(name) => editPack(pi, { name })} />
        <div class="st-emote-grid">
          ${slots.map((slot, si) => {
            const mediaSlot = { at: ['emotes', pack.key, 'slots', slot.key, 'image'], field: 'image', kind: 'image' };
            const previewUrl = liveSlots[slot.key]?.image || '';
            const wireId = makeCustomEmoteId(pack.key, slot.key);
            return html`<div class="st-emote-slot" key=${si}>
              <div class="st-emote-slot__head">
                <button type="button" class="st-emote-thumb" disabled=${!previewUrl || !wireId}
                  title=${previewUrl ? t('点击预览气泡') : ''}
                  onClick=${() => wireId && setBubble({ id: wireId, seq: Date.now() })}>
                  ${previewUrl ? html`<img src=${previewUrl} alt=${slot.label || slot.key} />` : html`<span>${si + 1}</span>`}
                </button>
                <div class="st-emote-slot__fields">
                  <${Line} label=${t('槽位键')} value=${slot.key} onChange=${(key) => editSlot(pi, si, { key })} />
                  <${Line} label=${t('标签')} value=${slot.label ?? ''} maxLength=${64} onChange=${(label) => editSlot(pi, si, { label })} />
                </div>
              </div>
              <div class="st-emote-slot__media">
                <${Upload} label=${t('上传图片')} accept=${art.accept(mediaSlot)} multiple=${false} disabled=${busy || dirty}
                  onFiles=${(files) => upload(mediaSlot, files)} />
                ${slot.image ? html`<${Button} size="sm" disabled=${busy || dirty} onClick=${() => onClear(mediaSlot)}>${t('清除素材')}<//>` : null}
                <${Button} size="sm" onClick=${() => editPack(pi, { slots: slots.filter((_, j) => j !== si) })}>${t('删除槽位')}<//>
              </div>
              <small>${art.hint(mediaSlot)}</small>
            </div>`;
          })}
        </div>
        <div class="st-emote-actions">
          <${Button} size="sm" disabled=${slots.length >= CUSTOM_EMOTE_SLOTS_PER_PACK} onClick=${() => {
            const key = Array.from({ length: CUSTOM_EMOTE_SLOTS_PER_PACK + 1 }, (_, i) => `slot-${i + 1}`).find((k) => !slots.some((s) => s.key === k));
            editPack(pi, { slots: [...slots, { key, label: `${t('表情')} ${slots.length + 1}` }] });
          }}>${t('添加表情格')}<//>
          ${o.packs.length > 1 ? html`<${Button} size="sm" onClick=${() => change(o.packs.filter((_, i) => i !== pi))}>${t('删除此页')}<//>` : null}
        </div>
      </fieldset>`;
    })}
    <${Button} disabled=${o.packs.length >= EMOTE_PACKS_MAX} onClick=${() => {
      const key = Array.from({ length: EMOTE_PACKS_MAX + 1 }, (_, i) => `pack-${i + 1}`).find((k) => !o.packs.some((p) => p.key === k));
      change([...o.packs, { key, name: `${t('自定义表情包')} ${o.packs.length + 1}`, slots: [{ key: 'slot-1', label: `${t('表情')} 1` }] }]);
    }}>${t('添加表情页')}<//>
    ${bubble ? html`<div class="st-emote-preview" data-testid="emote-bubble-preview">
      <span>${t('气泡预览')}</span>
      <${EmoteBubble} key=${bubble.seq} id=${bubble.id} />
    </div>` : null}
    <${PresentationIssues} draft=${draft} />
  </div>`;
}

export default { id: 'emotes', Component: EmotesEditor };
