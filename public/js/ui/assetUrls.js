// Asset URL resolution against data/assets.json (docs/ASSETS.md). Pure: every function takes the
// manifest object (or null) and returns a URL string or null — callers draw their own fallback
// (glyph, CSS shape) when null. Only URLs present in the manifest are ever returned, so the client
// never requests files the asset pipeline did not produce (no 404 noise in the console). The 特训敌人 type,
// 评语 and medal icons also read the local client's extraction (data/local-assets.json ui/outer, the same rule:
// listed files only) for the ones no mirror carries — 规程's critic_icon / reborn_icon, its eighteen
// comment_icon_N_M titles and trophy_level6–8 (the owner's report of 2026-11-14, §37.201).

import { localAsset } from '../data.js';

const str = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : null);

/** Skin pictures belong to the effective operator, never the original chess of a stand-in / DIY slot. */
function skinPicture(m, chess, skinId, field) {
  if (!skinId) return null;
  const id = chess?.charId || str(chess?.assets?.[field])?.replace(/_[12]$/, '');
  const skin = m?.chars?.[id]?.skins?.[skinId];
  const elite = chess?.isGolden || /_2$/.test(chess?.assets?.[field] || '');
  return str(elite && skin?.[`${field}E2`]) || str(skin?.[field]) || (field === 'portrait' ? str(skin?.illust) : null);
}

/** @param {any} m manifest @param {string} key 'group/key' */
export function uiUrl(m, key) {
  return str(obj(obj(m)?.ui)?.[key]);
}

/**
 * Operator avatar for a chess record (golden → E2 art when present).
 * @param {any} m manifest
 * @param {any} chess chess.json record (or { assets: { avatar } })
 */
export function chessAvatarUrl(m, chess, { skin = null } = {}) {
  const picture = skinPicture(m, chess, skin, 'avatar');
  if (picture) return picture;
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.avatar) || str(chess?.charId);
  if (!chars || !id) return null;
  if (id.endsWith('_2') && !chars[id]) {
    const base = chars[id.slice(0, -2)];
    return str(base?.avatarE2) || str(base?.avatar);
  }
  // A golden piece whose avatar id is the character key uses that entry's E2 art when it has one.
  // Official ids are `charId` or `charId_2` (the suffix branch above). Model and voice have no E2
  // field on the character entry: the composed `spine` / `voice` id is already the form's.
  const entry = chars[id];
  if (entry && chess?.isGolden && str(entry.avatarE2)) return str(entry.avatarE2);
  return str(entry?.avatar) || (chess?.charId ? str(chars[chess.charId]?.avatar) : null);
}

/**
 * Half-body portrait (180×360) for a chess record (golden → E2 portrait when present).
 * @param {any} m
 * @param {any} chess
 */
export function chessPortraitUrl(m, chess, { skin = null } = {}) {
  const picture = skinPicture(m, chess, skin, 'portrait');
  if (picture) return picture;
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.portrait);
  if (!chars) return null;
  if (id) {
    // A golden piece whose portrait id is the character key uses portraitE2 when the entry has one.
    // An entry with only `portrait` (a custom golden URL included) keeps that URL. Official ids are
    // `charId_1` / `charId_2` and are not character keys, so they stay on the suffix branches below.
    if (chars[id]) return (chess?.isGolden ? str(chars[id].portraitE2) : null) || str(chars[id].portrait);
    if (id.endsWith('_2')) {
      const base = chars[id.slice(0, -2)];
      if (base) return str(base.portraitE2) || str(base.portrait);
    }
    if (id.endsWith('_1')) {
      const base = chars[id.slice(0, -2)];
      if (base) return str(base.portrait);
    }
  }
  const byChar = chess?.charId ? chars[chess.charId] : null;
  if (!byChar) return null;
  return (chess?.isGolden ? str(byChar.portraitE2) : null) || str(byChar.portrait);
}

/** Where this installation's waiting-room card pictures live (server/plugins/artReferences.js ROOM_ART_URL). A served
 *  manifest inserts the content hash (`/assets/~<hash>/…`, shared/assetPaths.js), so that segment is optional here. */
const ROOM_CARD_URL = /^\/assets\/(?:~[0-9a-f]{16}\/)?local\/skins\/room-cards\/(char_[0-9]+_[a-z0-9]+)\/([a-z0-9][a-z0-9_-]{0,63})\.webp$/;

/** Old picture URL → the high-resolution cards cropped from it, built once per manifest object (see roomCardPortraitUrls). */
const roomCardIndex = new WeakMap();

/**
 * The room-card pictures of a manifest, by the picture they reproduce: `roomPortraitOf` must be the record's own key,
 * so a record a plugin copied whole from another operator (`{ "ref": "char_…" }`) contributes no room card.
 * @param {any} m
 * @returns {Map<string, {url: string, skinId: string | null}[]>}
 */
function roomCardsOf(m) {
  const index = new Map();
  if (!m || typeof m !== 'object') return index;
  const cached = roomCardIndex.get(m);
  if (cached) return cached;
  const add = (entryId, owner, from, url, skinId) => {
    if (owner !== entryId || typeof from !== 'string' || typeof url !== 'string') return;
    const match = ROOM_CARD_URL.exec(url);
    if (!match || match[1] !== entryId) return;
    let list = index.get(from);
    if (!list) index.set(from, (list = []));
    if (!list.some((hit) => hit.url === url && hit.skinId === skinId)) list.push({ url, skinId });
  };
  const chars = obj(obj(m)?.chars);
  for (const [entryId, entry] of Object.entries(chars || {})) {
    if (!obj(entry)) continue;
    const owner = str(entry.roomPortraitOf);
    add(entryId, owner, str(entry.roomPortraitFrom), str(entry.roomPortrait), null);
    add(entryId, owner, str(entry.roomPortraitE2From), str(entry.roomPortraitE2), null);
    for (const [skinId, skin] of Object.entries(obj(entry.skins) || {})) {
      if (!obj(skin)) continue;
      add(entryId, owner, str(skin.roomPortraitFrom), str(skin.roomPortrait), skinId);
      add(entryId, owner, str(skin.roomPortraitE2From), str(skin.roomPortraitE2), skinId);
    }
  }
  roomCardIndex.set(m, index);
  return index;
}

/**
 * The pictures a room seat card may draw, best first (waiting room only, screens/room.js): the high-resolution re-crop
 * of the outfit's picture, the outfit's picture, then the operator's default picture and its re-crop — a picture that
 * failed to load is skipped by the card, the last fallback is its avatar frame. A high-resolution URL is used only while
 * the picture it was cropped from (`roomPortraitFrom`) is still the one this manifest draws for this operator and stage:
 * a plugin that gives the card another picture, a record copied over from another operator, or another elite stage's
 * art all leave the card on the picture this installation actually has (`chessPortraitUrl`'s rules).
 * @param {any} m manifest
 * @param {any} chess chess.json record
 * @param {{ skin?: string | null }} [opts] the outfit the seat card wears (ui/skins.js ownerSkin)
 * @returns {string[]}
 */
export function roomCardPortraitUrls(m, chess, { skin = null } = {}) {
  const index = roomCardsOf(m);
  const picture = (old, skinId) => {
    const hit = index.get(str(old))?.find((h) => h.skinId === (skinId || null));
    return hit ? hit.url : null;
  };
  const outfit = str(skin) ? str(chessPortraitUrl(m, chess, { skin })) : null;
  const fallback = str(chessPortraitUrl(m, chess));
  const out = [];
  const add = (url) => { const v = str(url); if (v && !out.includes(v)) out.push(v); };
  // A skin this manifest does not know draws the default picture: one list, with its own high-resolution copy first.
  if (outfit && outfit !== fallback) {
    add(picture(outfit, skin));
    add(outfit);
    add(picture(fallback, null));
    add(fallback);
  } else {
    add(picture(fallback, null));
    add(fallback);
  }
  return out;
}

/** Skill icon of a chess record (manifest `skills[iconId]`, else the empty skill sprite). */
export function skillIconUrl(m, chess) {
  const skills = obj(obj(m)?.skills);
  const id = str(chess?.assets?.skillIcon) || str(chess?.skill?.iconId) || str(chess?.skill?.skillId);
  if (skills && id && skills[id]) return str(skills[id]);
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && chess?.skill?.skillId ? byId[chess.skill.skillId] : null;
  if (skills && alt && skills[alt]) return str(skills[alt]);
  return uiUrl(m, 'skillIcon/empty');
}

/**
 * Skill icon of one skill record (DESIGN §16 `skills[]`: iconId / skillId), else the empty skill sprite — or null with
 * `{ empty: false }` (the asset manifest only carries the default skills' icons: callers then draw a lettered S1–S3
 * tile instead of a blank square).
 */
export function skillRecordIconUrl(m, skill, { empty = true } = {}) {
  const skills = obj(obj(m)?.skills);
  for (const id of [str(skill?.iconId), str(skill?.skillId)]) if (skills && id && skills[id]) return str(skills[id]);
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && skill?.skillId ? byId[skill.skillId] : null;
  if (skills && alt && skills[alt]) return str(skills[alt]);
  return empty ? uiUrl(m, 'skillIcon/empty') : null;
}

const PROF_KEY = {
  PIONEER: 'pioneer', WARRIOR: 'warrior', TANK: 'tank', SNIPER: 'sniper', CASTER: 'caster', MEDIC: 'medic',
  SUPPORT: 'support', SPECIAL: 'special',
};

/** Profession icon (small white glyph). */
export function profIconUrl(m, profession) {
  const k = PROF_KEY[String(profession || '').toUpperCase()];
  return k ? str(obj(obj(obj(m)?.prof)?.icon)?.[k]) : null;
}

/** White-on-transparent profession sign used by the regulation shop prefab (asset plan `prof.mark`). */
export function profMarkUrl(m, profession) {
  const v = obj(obj(obj(m)?.prof)?.mark)?.[String(profession || '').toLowerCase()];
  return str(v) || profIconUrl(m, profession);
}

/** Square profession glyph (manifest `prof.large`: a black glyph on white, drawn as a white one by loadout.css). */
export function profGlyphUrl(m, profession) {
  const v = obj(obj(obj(m)?.prof)?.large)?.[String(profession || '').toLowerCase()];
  return str(v);
}

/** Sub-profession icon from a chess record (`assets.subProfIcon` = 'sub_<id>_icon'). */
export function subProfIconUrl(m, chess) {
  const sub = obj(obj(obj(m)?.prof)?.sub);
  if (!sub) return null;
  const raw = str(chess?.assets?.subProfIcon);
  const id = raw ? raw.replace(/^sub_/, '').replace(/_icon$/, '') : str(chess?.subProfessionId);
  return id ? str(sub[id]) : null;
}

/** Bond glyph (white; tint in CSS). */
export function bondIconUrl(m, bondId) {
  return bondId ? str(obj(obj(m)?.bonds)?.[bondId]) : null;
}

/** Band (strategy) icon. */
export function bandIconUrl(m, bandId) {
  return bandId ? str(obj(obj(m)?.bands)?.[bandId]) : null;
}

/** Item icon for an items.json record (by trapId / iconId) or a raw trap id. */
export function itemIconUrl(m, item) {
  const items = obj(obj(m)?.items);
  if (!items) return null;
  if (typeof item === 'string') return str(items[item]);
  return str(items[item?.iconId]) || str(items[item?.trapId]);
}

/** Enemy icon (manifest keeps fallbacks resolved). */
export function enemyIconUrl(m, enemyKey) {
  const e = enemyKey ? obj(obj(obj(m)?.enemies)?.[enemyKey]) : null;
  if (e?.icon) return str(e.icon);
  // `_2` / `_3` variants fall back to their base enemy
  const base = typeof enemyKey === 'string' ? enemyKey.replace(/_\d+$/, '') : null;
  return base && base !== enemyKey ? str(obj(obj(obj(m)?.enemies)?.[base])?.icon) : null;
}

/** Token avatar: `tokens[id].skins[opts.skin]`, else the token's avatar, else its owner's (docs/SKINS.md). */
export function tokenAvatarUrl(m, tokenId, opts) {
  if (typeof tokenId !== 'string' || !tokenId) return null;
  const t = obj(obj(obj(m)?.tokens)?.[tokenId]);
  const skin = t && opts?.skin ? obj(obj(t.skins)?.[String(opts.skin)]) : null;
  if (skin?.avatar) return str(skin.avatar);
  if (t?.avatar) return str(t.avatar);
  if (t?.owner) return str(obj(obj(obj(m)?.chars)?.[t.owner])?.avatar);
  // a map character or an enemy fielded as a summon (预备干员-医疗 char_605_cmedic, Touch char_613_acmedc, “炎佑”
  // enemy_9012_acloon) has no token picture: its own avatar / enemy icon, as the board draws it (assets.js
  // unitPictureUrl) — the detail card and the thumbnails showed none (§37.201, tools/ui-asset-refs.mjs)
  if (tokenId.startsWith('char_')) return str(obj(obj(obj(m)?.chars)?.[tokenId])?.avatar);
  if (tokenId.startsWith('enemy_')) return str(obj(obj(obj(m)?.enemies)?.[tokenId])?.icon);
  return null;
}

/** Faction (特训敌人 type) icon: `enemyTypeIcon/<icon>`, else the local extraction's ui/outer sprite. */
export function factionIconUrl(m, iconId) {
  return iconId ? uiUrl(m, `enemyTypeIcon/${iconId}`) || localAsset('ui/outer', iconId) : null;
}

/** Title (评语) icon: `titleIcon/<picId>`, else the local extraction's ui/outer sprite. */
export function titleIconUrl(m, picId) {
  return picId ? uiUrl(m, `titleIcon/${picId}`) || localAsset('ui/outer', picId) : null;
}

/** Medal (trophy count) icon: `medalIcon/<iconId>`, else the local extraction's ui/outer sprite. */
export function medalIconUrl(m, iconId) {
  return iconId ? uiUrl(m, `medalIcon/${iconId}`) || localAsset('ui/outer', iconId) : null;
}

/** Greek type letters of some modules (ISW-α, …) → the Latin letter of the client's icon file names (isw-a). */
const GREEK = { 'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'Δ': 'd' };
/** Lower-cased key → path index of a local `groups.module` object (built once per manifest object). */
const moduleIconIndex = new WeakMap();

/**
 * Official module (uniequip) TYPE icon from the local-client art (DESIGN §13 / §16): `data/local-assets.json`
 * `groups.module[<type>]`, matched case-insensitively against the module's typeName ('MAR-X' → key 'mar-x', 'PRI-X' →
 * key 'PRI-X' — the client's file names are mixed case). null when the manifest, the group or the entry is missing
 * (callers draw the lettered tile / type text instead).
 * @param {any} local the local-art manifest (`data.get('local')`) or null
 * @param {string} typeName e.g. 'MAR-X'
 */
export function moduleTypeIconUrl(local, typeName) {
  const g = obj(obj(obj(local)?.groups)?.module);
  const t = str(typeName)?.trim();
  if (!g || !t) return null;
  const exact = str(obj(g[t])?.path);
  if (exact) return exact;
  let idx = moduleIconIndex.get(g);
  if (!idx) {
    idx = new Map();
    for (const [k, v] of Object.entries(g)) {
      const p = str(obj(v)?.path);
      if (p && !idx.has(k.toLowerCase())) idx.set(k.toLowerCase(), p);
    }
    moduleIconIndex.set(g, idx);
  }
  const key = t.replace(/[αβγδΔ]/g, (c) => GREEK[c]).toLowerCase();
  return idx.get(key) || null;
}

/**
 * Icon for an m.private.effects entry: { iconKind: 'band'|'choice'|'team'|'item'|'garrison', iconId }.
 * @param {any} m
 * @param {{ iconKind?: string, iconId?: string }} eff
 */
export function effectIconUrl(m, eff) {
  const kind = eff?.iconKind;
  const id = str(eff?.iconId);
  if (kind === 'band') return bandIconUrl(m, id) || (id && id.startsWith('icon_') ? bandIconUrl(m, `band_${id.slice(5)}`) : null);
  if (kind === 'item') return itemIconUrl(m, id);
  if (kind === 'garrison') return uiUrl(m, `garrisonTypeIcon/${id || 's_icon_bond'}`) || uiUrl(m, 'garrisonTypeIcon/s_icon_bond');
  if (kind === 'team') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_team_buff'}`);
  if (kind === 'choice') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_player_buff'}`);
  return id ? uiUrl(m, `buffIcon/${id}`) : null;
}
