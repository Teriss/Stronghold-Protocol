// Single-operator loadout dialog shared by formal match PREP (screens/game.js) and Test Scene (screens/testScene.js).
// Reads and writes the same browser stores as the full 干员调配 screen (loadoutStore + skinsStore → localStorage),
// so edits made anywhere — formal match, Test Scene, or the 干员调配 screen — share one persisted source of truth.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { data } from '../data.js';
import { useStore } from '../store.js';
import { audio } from '../audio.js';
import { html, Button, Icon, TierChip } from './components.js';
import { OperatorImage, UnitThumb } from './gameComponents.js';
import { SkillSection, ModuleSection } from '../screens/loadoutSections.js';
import { CultivationSection } from '../screens/cultivation.js';
import { LoadoutStats } from './loadoutStats.js';
import { SkinSection } from './skinPicker.js';
import {
  chessOptions, effectiveChoice, setChoice, resetChoice, opsOf, setOps, resetOps, MODULE_NONE,
} from './loadoutModel.js';
import {
  loadoutStore, setEntries, setByCharChoice, setOpsMap, setDiyPicks,
} from './loadoutSync.js';
import { pickChoices, defaultPick, setPick } from './diyModel.js';
import { skinsStore, SKINS_KEY, clearSkin } from './skins.js';
import { diyRecord, diySlot, checkDiyPick, isPrototypePick } from '../../../shared/diy.js';
import { t } from '../../../shared/i18n.js';

function rawDataFrom(raw) {
  return {
    chess: raw?.chess || data.getRaw('chess') || data.get('chess') || {},
    backups: raw?.backups || data.getRaw('backups') || data.get('backups') || null,
  };
}

function localizedDataFrom(rawData) {
  return {
    chess: data.get('chess') || rawData.chess,
    backups: data.get('backups') || rawData.backups,
  };
}

/**
 * Resolve a DIY operator's effective saved pick from the unified stores:
 * 1. Matching formal DIY slot in `loadoutStore.diy` (same slotId first, else any slot holding `charId`)
 * 2. Saved per-operator choice in `loadoutStore.byChar[charId]` (for DIY operators not in the 4 formal slots)
 * 3. Passed-in piece pick (if any) or the default pick for `(charId, slotId)`.
 */
export function resolveSavedDiyPick(rawData, slotId, charId, saved = {}, fallbackPick = null) {
  const slot = diySlot(slotId, rawData);
  if (!slot || !charId) return null;
  const def = defaultPick(charId, slot.baseId, rawData);
  const proto = isPrototypePick(rawData, slot.tier, charId);
  if (proto) {
    const checked = checkDiyPick(slot.baseId, { charId }, rawData);
    return {
      pick: 'ok' in checked ? checked.pick : { charId, skillIndex: 0, uniEquipId: null },
      defPick: 'ok' in checked ? checked.pick : { charId, skillIndex: 0, uniEquipId: null },
      diySlotKey: saved.diy?.[slot.baseId]?.charId === charId ? slot.baseId : null,
      isProto: true,
    };
  }
  const defChecked = checkDiyPick(slot.baseId, def, rawData);
  const defPick = 'ok' in defChecked ? defChecked.pick : { charId, skillIndex: def.skillIndex ?? 0, uniEquipId: def.uniEquipId ?? null };
  let diySlotKey = null;
  let slotPick = null;
  if (saved.diy?.[slot.baseId]?.charId === charId) {
    diySlotKey = slot.baseId;
    slotPick = saved.diy[slot.baseId];
  } else if (saved.diy && typeof saved.diy === 'object') {
    for (const [k, v] of Object.entries(saved.diy)) {
      if (v && v.charId === charId) { diySlotKey = k; slotPick = v; break; }
    }
  }
  const ch = pickChoices(charId, slot.baseId, rawData);
  const legalSkills = new Set((ch?.skills || []).map(s => s.index));
  const legalMods = new Set((ch?.modules || []).map(m => m.uniEquipId));
  let skillIndex = defPick.skillIndex;
  let uniEquipId = defPick.uniEquipId ?? null;
  if (slotPick) {
    if (Number.isInteger(slotPick.skillIndex) && legalSkills.has(slotPick.skillIndex)) skillIndex = slotPick.skillIndex;
    if (slotPick.uniEquipId == null) uniEquipId = null;
    else if (legalMods.has(slotPick.uniEquipId)) uniEquipId = slotPick.uniEquipId;
  } else if (saved.byChar && Object.hasOwn(saved.byChar, charId)) {
    const bc = saved.byChar[charId];
    if (bc && Number.isInteger(bc.skill) && legalSkills.has(bc.skill)) skillIndex = bc.skill;
    if (bc && typeof bc.module === 'string') {
      if (bc.module === MODULE_NONE) uniEquipId = null;
      else if (legalMods.has(bc.module)) uniEquipId = bc.module;
    }
  } else if (fallbackPick && fallbackPick.charId === charId) {
    if (Number.isInteger(fallbackPick.skillIndex) && legalSkills.has(fallbackPick.skillIndex)) skillIndex = fallbackPick.skillIndex;
    if (fallbackPick.uniEquipId == null) uniEquipId = null;
    else if (legalMods.has(fallbackPick.uniEquipId)) uniEquipId = fallbackPick.uniEquipId;
  }
  const checked = checkDiyPick(slot.baseId, { charId, skillIndex, uniEquipId }, rawData);
  return {
    pick: 'ok' in checked ? checked.pick : defPick,
    defPick,
    diySlotKey,
    isProto: false,
  };
}

/**
 * Whether an operator currently has any non-default configuration (skill, module, potential, cultivate, or skin)
 * in the unified saved stores.
 */
export function isOperatorConfigured(raw, { chessId, diy = null }, saved = null) {
  if (!chessId) return false;
  const rawData = rawDataFrom(raw);
  const rec = rawData.chess?.[chessId];
  if (!rec) return false;
  const baseId = rec.baseId || chessId;
  const base = rawData.chess[baseId] || rec;
  const storeState = saved || { ...loadoutStore.get(), skins: skinsStore.get()[SKINS_KEY] || {} };
  const skins = storeState.skins || {};
  if (base.isDiy) {
    const charId = diy?.charId || storeState.diy?.[baseId]?.charId || null;
    if (!charId) return false;
    const resolved = resolveSavedDiyPick(rawData, baseId, charId, storeState, diy);
    if (!resolved) return false;
    const pickChanged = !resolved.isProto && (
      resolved.pick.skillIndex !== resolved.defPick.skillIndex
      || (resolved.pick.uniEquipId ?? null) !== (resolved.defPick.uniEquipId ?? null)
    );
    const opsChanged = !resolved.isProto && opsOf(storeState.ops, charId).changed;
    return pickChanged || opsChanged || Boolean(skins[charId]);
  }
  const golden = base.goldenId ? rawData.chess[base.goldenId] || null : (rec.isGolden ? rec : null);
  const eff = effectiveChoice(storeState.entries, base, golden);
  return eff.changed || opsOf(storeState.ops, base.charId).changed || Boolean(skins[base.charId]);
}

/**
 * Modal editor for one operator's skin, skill, module, potential, and cultivation.
 * Writes directly to `loadoutStore` and `skinsStore` so formal matches, Test Scene, and 干员调配 share one save.
 * @param {{ chessId: string, diy?: any, golden?: boolean, ownerId?: string, raw?: any, onClose: () => void }} props
 */
export function OperatorLoadoutDialog({ chessId, diy = null, golden = null, ownerId = null, raw = null, onClose }) {
  const st = useStore(s => s, Object.is, loadoutStore);
  const skins = useStore(s => s[SKINS_KEY] || {}, Object.is, skinsStore);
  const rawData = rawDataFrom(raw);
  const locData = localizedDataFrom(rawData);
  const clickedRaw = rawData.chess?.[chessId] || null;
  const isGolden = golden != null ? Boolean(golden) : Boolean(clickedRaw?.isGolden);

  const [skillLevel, setSkillLevel] = useState(isGolden ? 'elite' : 'normal');
  const [statLevel, setStatLevel] = useState(isGolden ? 'elite' : 'normal');

  useEffect(() => {
    const nextLevel = isGolden ? 'elite' : 'normal';
    setSkillLevel(nextLevel);
    setStatLevel(nextLevel);
  }, [chessId, diy?.charId, isGolden]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.modal')) return;
      e.preventDefault();
      e.stopImmediatePropagation?.();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!clickedRaw) return null;
  const baseId = clickedRaw.baseId || chessId;
  const normalRaw = rawData.chess[baseId] || clickedRaw;
  const isDiy = Boolean(normalRaw.isDiy);
  const m = data.get('assets');

  let charId, baseRec, goldenRec, skillOptions, moduleOptions, curSkill, curModule, isProto = false;
  let diyResolved = null;
  let changed;

  if (isDiy) {
    charId = diy?.charId || st.diy?.[baseId]?.charId || null;
    if (!charId) return null;
    const slot = diySlot(baseId, rawData);
    if (!slot) return null;
    diyResolved = resolveSavedDiyPick(rawData, baseId, charId, st, diy);
    if (!diyResolved) return null;
    isProto = diyResolved.isProto;
    const activePick = diyResolved.pick;
    curSkill = activePick.skillIndex;
    curModule = activePick.uniEquipId ?? MODULE_NONE;
    baseRec = diyRecord(slot.baseId, activePick, { elite: false, data: locData })
      || diyRecord(slot.baseId, activePick, { elite: false, data: rawData });
    goldenRec = diyRecord(slot.goldenId, activePick, { elite: true, data: locData })
      || diyRecord(slot.goldenId, activePick, { elite: true, data: rawData });
    const ch = pickChoices(charId, slot.baseId, locData) || pickChoices(charId, slot.baseId, rawData);
    skillOptions = !ch ? []
      : (ch.proto ? ch.skills.filter(s => s.index === curSkill) : ch.skills)
        .map(s => ({ ...s, isDefault: !ch.proto && s.index === diyResolved.defPick.skillIndex }));
    const defModId = diyResolved.defPick.uniEquipId ?? MODULE_NONE;
    moduleOptions = !ch ? []
      : ch.proto
        ? [{ id: ch.locked?.uniEquipId ?? MODULE_NONE, rec: ch.modules.find(x => x.uniEquipId === ch.locked?.uniEquipId)?.rec ?? null, isDefault: true }]
        : [
          { id: MODULE_NONE, rec: null, isDefault: defModId === MODULE_NONE },
          ...ch.modules.map(mo => ({ id: mo.uniEquipId, rec: mo.rec, isDefault: mo.uniEquipId === defModId })),
        ];
    changed = (!isProto && (curSkill !== diyResolved.defPick.skillIndex || curModule !== defModId))
      || (!isProto && opsOf(st.ops, charId).changed)
      || Boolean(skins[charId]);
  } else {
    charId = normalRaw.charId;
    const goldenId = normalRaw.goldenId || (isGolden ? chessId : null);
    baseRec = data.lookup('chess', baseId) || normalRaw;
    goldenRec = goldenId ? (data.lookup('chess', goldenId) || rawData.chess[goldenId]) : null;
    const opt = chessOptions(baseRec, goldenRec);
    const eff = effectiveChoice(st.entries, baseRec, goldenRec);
    curSkill = eff.skill;
    curModule = eff.module ?? MODULE_NONE;
    skillOptions = opt.skillOptions;
    moduleOptions = [...opt.moduleOptions].sort((a, b) => Number(b.id === MODULE_NONE) - Number(a.id === MODULE_NONE));
    changed = eff.changed || opsOf(st.ops, charId).changed || Boolean(skins[charId]);
  }

  const displayRec = (isGolden && goldenRec) || baseRec;
  if (!displayRec) return null;

  const skin = skins[charId] || null;
  const ops = isProto ? null : st.ops;
  const effOps = isProto ? null : opsOf(st.ops, charId);
  const hasModules = Boolean(goldenRec && moduleOptions.some(mo => mo.id !== MODULE_NONE));

  const persistDiyChoice = (nextSkill, nextModuleId) => {
    if (!diyResolved || isProto) return;
    const slot = diySlot(baseId, rawData);
    if (!slot) return;
    const uniEquipId = nextModuleId === MODULE_NONE || !nextModuleId ? null : nextModuleId;
    const checked = checkDiyPick(slot.baseId, { charId, skillIndex: nextSkill, uniEquipId }, rawData);
    if (!('ok' in checked)) return;
    const curStore = loadoutStore.get();
    if (diyResolved.diySlotKey) {
      setDiyPicks(setPick(curStore.diy, diyResolved.diySlotKey, {
        charId,
        skillIndex: checked.pick.skillIndex,
        uniEquipId: checked.pick.uniEquipId,
      }));
    }
    const defModId = diyResolved.defPick.uniEquipId ?? MODULE_NONE;
    const chosenModId = checked.pick.uniEquipId ?? MODULE_NONE;
    const bc = {};
    if (checked.pick.skillIndex !== diyResolved.defPick.skillIndex) bc.skill = checked.pick.skillIndex;
    if (chosenModId !== defModId) bc.module = chosenModId;
    setByCharChoice(charId, Object.keys(bc).length ? bc : null);
    audio.sfx('click', { volume: 0.4 });
  };

  const handleSkill = (skillIndex) => {
    if (isDiy) { persistDiyChoice(skillIndex, curModule); return; }
    const cur = loadoutStore.get().entries;
    setEntries(setChoice(cur, baseRec, goldenRec, { skill: skillIndex }), { base: cur, lookup: id => rawData.chess[id] });
    audio.sfx('click', { volume: 0.4 });
  };

  const handleModule = (moduleId) => {
    if (isDiy) { persistDiyChoice(curSkill, moduleId); return; }
    const cur = loadoutStore.get().entries;
    setEntries(setChoice(cur, baseRec, goldenRec, { module: moduleId }), { base: cur, lookup: id => rawData.chess[id] });
    audio.sfx('click', { volume: 0.4 });
  };

  const handleOps = (_cid, patch) => {
    if (isProto) return;
    setOpsMap(setOps(loadoutStore.get().ops, charId, patch));
    audio.sfx('click', { volume: 0.4 });
  };

  const handleReset = () => {
    if (isDiy) {
      if (!isProto && diyResolved) {
        if (diyResolved.diySlotKey) {
          setDiyPicks(setPick(loadoutStore.get().diy, diyResolved.diySlotKey, {
            charId,
            skillIndex: diyResolved.defPick.skillIndex,
            uniEquipId: diyResolved.defPick.uniEquipId ?? null,
          }));
        }
        setByCharChoice(charId, null);
        setOpsMap(resetOps(loadoutStore.get().ops, charId));
      }
    } else {
      const cur = loadoutStore.get().entries;
      setEntries(resetChoice(cur, baseId), { base: cur, lookup: id => rawData.chess[id] });
      setOpsMap(resetOps(loadoutStore.get().ops, charId));
    }
    if (skins[charId]) clearSkin(charId);
    audio.sfx('click', { volume: 0.4 });
  };

  const getChess = isDiy
    ? id => (id === goldenRec?.chessId ? goldenRec : id === baseRec?.chessId ? baseRec : data.lookup('chess', id) || rawData.chess[id])
    : id => data.lookup('chess', id) || rawData.chess[id];

  return html`<div class="ts-loadout-backdrop" onClick=${onClose}>
    <section class="ts-loadout-modal" data-testid="test-scene-loadout-modal" role="dialog" aria-modal="true"
      aria-label=${t('{name} 调配', { name: displayRec.name })} onClick=${e => e.stopPropagation()}>
      <header class="ts-loadout-head">
        <div class=${`lo-dhead__art lo-dhead__art--t${displayRec.tier}`}>
          <${OperatorImage} m=${m} chess=${displayRec} portrait ownerId=${ownerId} skin=${skin}
            fallback=${html`<${UnitThumb} kind="chess" id=${displayRec.chessId} size="lg" rec=${displayRec} ownerId=${ownerId} skin=${skin} />`} />
        </div>
        <div class="ts-loadout-head__info">
          <div class="lo-dhead__chips">
            <${TierChip} tier=${displayRec.tier} golden=${isGolden} size="md" />
            ${isGolden ? html`<span class="dtag-elite">${t('精锐')}</span>` : null}
            ${isDiy ? html`<span class="dtag-diy">${t('自选')}</span>` : null}
            ${changed ? html`<span class="lo-badge lo-badge--changed">${t('已调整')}</span>` : html`<span class="lo-badge lo-badge--plain">${t('默认配置')}</span>`}
          </div>
          <h3>${displayRec.name}</h3>
          ${displayRec.appellation ? html`<span class="lo-dhead__en">${displayRec.appellation}</span>` : null}
        </div>
        <div class="ts-loadout-head__actions">
          <${Button} variant="ghost" size="sm" icon="refresh" data-testid="test-scene-loadout-reset" disabled=${!changed} onClick=${handleReset}>${t('恢复默认')}<//>
          <button type="button" class="ts-loadout-close" aria-label=${t('关闭')} data-testid="test-scene-loadout-close" onClick=${onClose}><${Icon} name="close" /></button>
        </div>
      </header>
      <div class="lo-detail__body ts-loadout-body">
        <${SkinSection} charId=${charId} />
        <${SkillSection} m=${m} chess=${baseRec} golden=${goldenRec} skillOptions=${skillOptions}
          skill=${curSkill} level=${skillLevel} onLevel=${setSkillLevel}
          onPick=${handleSkill} locked=${isProto} />
        ${hasModules && !isGolden ? html`<p class="ts-loadout-note"><${Icon} name="info" />${t('模组仅在精锐形态生效')}</p>` : null}
        ${hasModules ? html`
          <${ModuleSection} m=${m} golden=${goldenRec} moduleOptions=${moduleOptions}
            module=${curModule} onPick=${handleModule}
            potential=${isProto ? null : effOps?.potential} locked=${isProto} />
        ` : null}
        ${isProto ? html`
          <p class="ts-loadout-note"><${Icon} name="info" />${t('原型干员的技能与补位时一致，不可更改')} · ${t('原型干员没有潜能与练度')}</p>
        ` : html`
          <${CultivationSection} charId=${charId} ops=${ops} onSet=${handleOps} />
        `}
        <${LoadoutStats} base=${baseRec} golden=${goldenRec} entries=${isDiy ? {} : st.entries} ops=${ops}
          level=${statLevel} onLevel=${setStatLevel} getChess=${getChess} />
      </div>
      <footer class="ts-loadout-foot">
        <${Button} variant="primary" size="sm" data-testid="test-scene-loadout-done" onClick=${onClose}>${t('完成')}<//>
      </footer>
    </section>
  </div>`;
}
