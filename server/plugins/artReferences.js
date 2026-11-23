// Optional extracted art: installed official operators outside the shipped roster (§34.28) and local skins.
// Uses W5's bounded JSON-only reader, including disabled plugins; never loads plugin code.
import fs from 'node:fs';
import path from 'node:path';
import { installedFxReferences } from './fxReferences.js';
import { ASSET_CONTAINERS, getPath, isSkinKey, readAssetOverlay } from '../../shared/plugins/visual.js';
import { issueList } from '../../shared/plugins/errors.js';

/** Where this installation's waiting-room card pictures live (tools/local-extract/room-cards.py). */
export const ROOM_ART_URL = '/assets/local/skins/room-cards/';
/** The fields a room card's high-resolution picture travels with: the picture it reproduces, and the operator it was
 *  cropped for (both in the sidecar, both kept in the served manifest so a page can check them). */
const ROOM_ART_FIELDS = Object.freeze([['roomPortrait', 'roomPortraitFrom'], ['roomPortraitE2', 'roomPortraitE2From']]);
const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.webp$/;
const CHAR_ID = /^char_[0-9]+_[a-z0-9]+$/;
const ART_REF = /^\/(?:assets|fonts)\/[^?#\\\0]+$/;

/** A room-card picture: this installation's own WebP, under <charId>/, safe segments only (null anywhere else). */
export function roomArtUrl(url, charId) {
  if (typeof url !== 'string' || !CHAR_ID.test(charId || '') || !url.startsWith(ROOM_ART_URL)) return null;
  const parts = url.slice(ROOM_ART_URL.length).split('/');
  return parts.length === 2 && parts[0] === charId && ROOM_NAME.test(parts[1]) ? url : null;
}

/** The picture a room-card art reproduces: an art URL of this installation, never a query, a hash or a relative path. */
const artReference = (url) => typeof url === 'string' && url.length <= 512 && ART_REF.test(url)
  && !url.split('/').some((s) => s === '.' || s === '..') ? url : null;

/**
 * One sidecar record's room-card fields, when it owns them: `roomPortraitOf` names the character the pictures were
 * cropped for, so a whole-record `{ ref }` of another operator's entry does not carry them over as this operator's.
 * @param {any} record a sidecar chars[] record or one of its skins
 * @param {string} charId the base entry record it is merged into
 * @returns {Record<string, string> | null}
 */
export function roomArtFields(record, charId) {
  if (!isObj(record) || record.roomPortraitOf !== charId) return null;
  const out = {};
  for (const [field, from] of ROOM_ART_FIELDS) {
    const url = roomArtUrl(record[field], charId);
    const old = artReference(record[from]);
    if (url && old) { out[field] = url; out[from] = old; }
  }
  return Object.keys(out).length ? { ...out, roomPortraitOf: charId } : null;
}

/** Add the room-card fields a base record lacks; an installed field wins, as every other merged slot does. */
function withRoomArt(existing, room) {
  const out = { ...existing };
  let added = false;
  for (const [k, v] of Object.entries(room)) {
    if (Object.hasOwn(existing, k)) continue;
    out[k] = v;
    added = true;
  }
  return added ? out : existing;
}

const read = (root, rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return {}; }
};

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** [ASSUMED] At most 256 distinct official operators per installation/run, shared with operators.py. */
export const ART_REFERENCE_LIMIT = 256;

/** Optional extracted art belongs to the installation's base, before cosmetic layers.
 * [ASSUMED] Existing base slots win; absent slots use local art. No author-facing fields are added. */
export function mergeLocalChars(base, local) {
  if (!isObj(base) || !isObj(local?.chars)) return base;
  const entries = Object.entries(local.chars).filter(([id, art]) => /^char_[0-9]+_[a-z0-9]+$/.test(id) && isObj(art));
  if (!entries.length) return base;
  const chars = { ...base.chars };
  for (const [id, art] of entries) {
    const existing = chars[id] || {};
    chars[id] = { ...art, ...existing };
    if (art.spine || existing.spine) chars[id].spine = { ...art.spine, ...existing.spine };
  }
  return { ...base, chars };
}

export const LOCAL_SKINS_MANIFEST = 'local-skins.json';
export const LOCAL_SKINS_URL = '/assets/local/skins/';
const safeKey = (key) => key !== 'prototype' && !(key in Object.prototype);
const safeSegment = (s) => s && !s.startsWith('.') && !s.endsWith('.') && !/[^A-Za-z0-9._~-]/.test(s)
  && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s);
const localSkinUrl = (url) => typeof url === 'string' && url.startsWith(LOCAL_SKINS_URL)
  && url.slice(LOCAL_SKINS_URL.length).split('/').every(safeSegment);
const skinImage = (url) => localSkinUrl(url) && /\.(?:png|jpe?g|webp)$/i.test(url);
// These are display/Spine metadata, not art URLs for the manifest's recursive hasher to rewrite.
const skinText = (v) => typeof v === 'string' && !/^\/(?:assets|fonts)\//.test(v);

/** Copy only JSON metadata, with no prototype keys at any depth. Real Spine records are at most a few levels deep. */
function skinMetadata(v, depth = 0) {
  if (skinText(v) || v === null || typeof v === 'boolean' || Number.isFinite(v)) return v;
  if (depth >= 8) return undefined;
  if (Array.isArray(v)) return v.map((x) => skinMetadata(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => safeKey(k)).map(([k, x]) => [k, skinMetadata(x, depth + 1)]));
}

function localSkinSpine(v) {
  if (!isObj(v) || !localSkinUrl(v.skel) || !v.skel.endsWith('.skel') || v.atlas !== v.skel.replace(/\.skel$/, '.atlas')
    || !isObj(v.anims)) return null;
  const dir = v.skel.slice(0, v.skel.lastIndexOf('/') + 1);
  if (v.textures !== undefined && (!Array.isArray(v.textures) || !v.textures.every((p) => skinImage(p) && p.startsWith(dir)))) return null;
  const out = { skel: v.skel, atlas: v.atlas };
  if (v.textures !== undefined) out.textures = [...v.textures];
  if (typeof v.pma === 'boolean') out.pma = v.pma;
  for (const k of ['anims', 'animations', 'events', 'hits', 'bounds']) {
    if (Object.hasOwn(v, k)) out[k] = skinMetadata(v[k]);
  }
  return out;
}

/** Add skins to known base entries only. Existing fields win; cosmetic plugins still layer over this result. */
export function mergeLocalSkins(base, local) {
  if (!isObj(base) || !isObj(local) || local.version !== 1) return base;
  let out = base;
  for (const kind of ['chars', 'tokens']) {
    if (!isObj(base[kind]) || !isObj(local[kind])) continue;
    let records = base[kind];
    for (const [id, record] of Object.entries(local[kind])) {
      if (!safeKey(id) || !Object.hasOwn(records, id) || !isObj(records[id]) || !isObj(record)) continue;
      const room = kind === 'chars' ? roomArtFields(record, id) : null;
      if (!room && !isObj(record.skins)) continue;
      const existing = records[id];
      const baseSkins = isObj(existing.skins) ? existing.skins : null;
      let skins = null;
      for (const [key, v] of Object.entries(record.skins || {})) {
        if (!isSkinKey(key) || !safeKey(key) || !isObj(v) || !skinText(v.name) || !v.name || !skinText(v.group)) continue;
        const skin = { name: v.name, group: v.group };
        let hasArt = false;
        for (const k of ['avatar', 'portrait', 'illust']) {
          if (skinImage(v[k])) { skin[k] = v[k]; hasArt = true; }
        }
        // the room card's picture of this outfit: art of the sidecar, never a reason to create the outfit
        const outfitRoom = roomArtFields(v, id);
        if (outfitRoom) Object.assign(skin, outfitRoom);
        const front = localSkinSpine(v.spine?.front);
        if (front) {
          const back = localSkinSpine(v.spine?.back);
          skin.spine = back ? { front, back } : { front };
          hasArt = true;
        }
        if (!hasArt) continue;
        const prev = baseSkins && Object.hasOwn(baseSkins, key) ? baseSkins[key] : undefined;
        if (prev !== undefined && !isObj(prev)) continue;
        const combined = { ...skin, ...prev };
        // An installed record's own room card keeps priority — but only a pair that still validates: a stray or
        // orphaned field there must not shadow the sidecar's picture and its binding.
        if (outfitRoom) {
          for (const [field, from] of ROOM_ART_FIELDS) {
            if (!Object.hasOwn(combined, field) && !Object.hasOwn(combined, from)) continue;
            if (roomArtUrl(combined[field], id) && artReference(combined[from])) continue;
            if (outfitRoom[field]) { combined[field] = outfitRoom[field]; combined[from] = outfitRoom[from]; }
            else { delete combined[field]; delete combined[from]; }
          }
        }
        if (front && isObj(prev?.spine)) {
          combined.spine = ['front', 'back'].some((k) => Object.hasOwn(skin.spine, k) && !Object.hasOwn(prev.spine, k))
            ? { ...skin.spine, ...prev.spine } : prev.spine;
        }
        if (prev && Object.keys(combined).every((k) => combined[k] === prev[k] && Object.hasOwn(prev, k))) continue;
        skins ||= { ...baseSkins };
        skins[key] = combined;
      }
      const withRoom = room ? withRoomArt(existing, room) : existing;
      if (!skins && withRoom === existing) continue;
      if (records === base[kind]) records = { ...records };
      records[id] = skins ? { ...withRoom, skins } : withRoom;
    }
    if (records !== base[kind]) {
      if (out === base) out = { ...base };
      out[kind] = records;
    }
  }
  return out;
}

/** Validate references against merged art, permissions against the original data/assets.json.
 * Keep this installation policy server-side: changing shared visual code would change vanilla's content hash.
 * @param {unknown} assets
 * @param {{ vanilla?: import('./registry.js').VanillaAssets, permissions?: string[] | null,
 *   has?: ((rel: string) => boolean) | null }} [ctx]
 */
export function readInstalledAssetOverlay(assets, { vanilla, permissions = null, has = null } = {}) {
  const base = vanilla?.baseManifest ?? vanilla?.manifest;
  const merged = vanilla?.manifest;
  if (base === merged) return readAssetOverlay(assets, { vanilla: merged, permissions, has });
  const ov = readAssetOverlay(assets, { vanilla: merged, has });
  const list = issueList();
  list.take(ov);
  if (base && Array.isArray(permissions)) {
    const told = new Set();
    // Same entry-level classification as shared/plugins/visual.js; local-only entries remain additions.
    for (const op of ov.ops) {
      if (op.implied) continue;
      const depth = ASSET_CONTAINERS.find(c => c.path.every((k, i) => op.at[i] === k))?.path.length ?? 1;
      const exists = getPath(base, op.at.slice(0, depth + 1)) !== undefined;
      const need = exists ? 'assets.override' : 'assets.add';
      if (!permissions.includes(need) && !told.has(need)) {
        told.add(need);
        list.problem('PLUGIN_PERMISSION_MISSING', `assets.${op.at.join('.')}: ${exists ? 'changes an entry of this installation\'s manifest' : 'adds an entry'} — needs the permission "${need}"`,
          { at: ['assets', ...op.at], need, needs: [need] });
      }
    }
  }
  return { ...ov, problems: list.problems, warnings: list.warnings, issues: list.issues };
}

export function installedArtReferences(root) {
  const chess = read(root, 'data/chess.json'), backups = read(root, 'data/backups.json');
  const table = read(root, '.cache/gamedata/excel/character_table.json');
  if (!isObj(table)) return [];
  const roster = new Set([...Object.values(chess).map(r => r?.charId), ...Object.keys(backups.units || {})]);
  // Syntax alone does not identify an official operator. Missing tables authorize no art discovery.
  return installedFxReferences(root, { artPhases: true }).filter(id => Object.hasOwn(table, id) && !roster.has(id)).slice(0, ART_REFERENCE_LIMIT);
}

/** [ASSUMED] Base pictures and both battle directions are required; E2 pictures only for a three-phase operator.
 * Missing files count as a gap too (copying a manifest alone does not install art). */
export function pluginArtGap(root) {
  const local = read(root, 'data/local-assets.json'), table = read(root, '.cache/gamedata/excel/character_table.json');
  const present = url => {
    if (typeof url !== 'string' || !/^\/assets\/local\/[A-Za-z0-9_./-]+$/.test(url)
      || url.split('/').some(p => p === '.' || p === '..')) return false;
    try { return fs.statSync(path.join(root, 'public', url)).isFile(); } catch { return false; }
  };
  return installedArtReferences(root).filter(id => {
    const art = local.chars?.[id];
    const pics = ['avatar', 'portrait', ...(table[id]?.phases?.length >= 3 ? ['avatarE2', 'portraitE2'] : [])];
    if (pics.some(k => !present(art?.[k]))) return true;
    return ['front', 'back'].some(face => {
      const m = art?.spine?.[face];
      return !m || !present(m.skel) || !present(m.atlas) || !m.textures?.length || !m.textures.every(present);
    });
  });
}
