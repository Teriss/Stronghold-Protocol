// server/plugins/serverEmotes.js — server-wide custom emote plugins controlled only by the server owner.
// Persisted in plugins/config.json (`"emotes": [...]`) and applied globally to every room and player on this server.

import { isPluginId } from '../../shared/plugins/manifest.js';
import { studioAllowed } from '../studio/gate.js';
import { sendJson } from '../http/common.js';
import { writePolicyEmotes } from './policy.js';

export const SERVER_EMOTES_PATH = '/api/server-emotes';
const MAX_BODY_BYTES = 16 * 1024;
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** True when a loaded cosmetic plugin declares at least one custom emote image slot. */
export function isEmotePlugin(p) {
  if (!p || p.class !== 'cosmetic' || p.status !== 'loaded') return false;
  const ops = Array.isArray(p.visual?.ops) ? p.visual.ops : [];
  return ops.some((op) => Array.isArray(op?.at) && op.at[0] === 'emotes' && op.at[2] === 'slots' && op.at[4] === 'image' && op.file);
}

function sameOriginWrite(req) {
  const sfs = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origin = req?.headers?.origin;
  if (origin) {
    try {
      const u = new URL(String(origin));
      const host = String(req?.headers?.host || '').trim().toLowerCase();
      if (!host || u.host.toLowerCase() !== host) return false;
    } catch { return false; }
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{ registry: any, visual: any, policy: any, pluginsDir: string | null, log?: object,
 *   onChange?: (st: { ids: string[], vs: string | null, customEmotes: string[] }) => void }} opts
 */
export function createServerEmotes({ registry, visual, policy, pluginsDir, log = noopLog, onChange = null }) {
  let heldVs = null;
  let lastSig = null;
  /** @type {{ ids: string[], vs: string | null, customEmotes: string[] }} */
  let current = { ids: [], vs: null, customEmotes: [] };
  /** In-memory override immediately after owner toggle (before policy's 1s mtime recheck). */
  let overrideIds = null;

  const available = () => {
    const all = registry?.plugins?.('cosmetic') || [];
    return all.filter(isEmotePlugin).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  const configuredIds = () => {
    const raw = overrideIds !== null ? overrideIds : (policy?.get?.().emotes || []);
    return Array.isArray(raw) ? raw.filter(isPluginId) : [];
  };

  const resolveState = (force = false) => {
    const avail = available();
    const availMap = new Map(avail.map((p) => [p.id, p]));
    const ids = configuredIds().filter((id) => availMap.has(id));
    const sig = ids.map((id) => `${id}:${availMap.get(id)?.visual?.hash || ''}`).join(',');
    if (!force && sig === lastSig) return current;
    lastSig = sig;
    let nextVs = null;
    let customEmotes = [];
    if (ids.length && visual) {
      const r = visual.resolve(ids, { scope: 'room' });
      if (r && r.ok && r.set) {
        nextVs = r.set.vs || null;
        customEmotes = Array.isArray(r.set.customEmotes) ? [...r.set.customEmotes] : [];
      } else if (r?.detail) {
        log.warn?.(`[server-emotes] resolve failed: ${r.detail}`);
      }
    }
    if (heldVs && heldVs !== nextVs) visual?.release?.(heldVs);
    if (nextVs && nextVs !== heldVs) visual?.hold?.(nextVs);
    heldVs = nextVs;
    current = { ids, vs: nextVs, customEmotes };
    return current;
  };

  const list = () => {
    const st = resolveState();
    const on = new Set(st.ids);
    return available().map((p) => ({
      id: p.id,
      name: p.manifest?.name || p.id,
      ...(p.manifest?.names && Object.keys(p.manifest.names).length ? { names: { ...p.manifest.names } } : {}),
      ...(p.manifest?.version ? { version: p.manifest.version } : {}),
      ...(Number.isFinite(p.bytes) ? { bytes: p.bytes } : {}),
      ...(Number.isFinite(p.visual?.bytes) ? { artBytes: p.visual.bytes } : {}),
      enabled: on.has(p.id),
    }));
  };

  const setEnabled = (id, enabled) => {
    if (!isPluginId(id)) return { error: 'BAD_ID', status: 400 };
    const avail = available();
    if (enabled && !avail.some((p) => p.id === id)) return { error: 'NOT_FOUND', status: 404 };
    const cur = configuredIds().filter((x) => x !== id);
    if (enabled) cur.push(id);
    const saved = pluginsDir ? writePolicyEmotes(pluginsDir, cur) : cur;
    overrideIds = saved;
    const st = resolveState(true);
    try { onChange?.(st); } catch (e) { log.error?.('[server-emotes] onChange failed', e); }
    return { ok: true, state: st, plugins: list() };
  };

  return {
    state: () => resolveState(),
    list,
    setEnabled,
    handles: (rawPath) => rawPath === SERVER_EMOTES_PATH,
    async handle(req, res) {
      const isOwner = studioAllowed(req).ok;
      if (req.method === 'GET' || req.method === 'HEAD') {
        const st = resolveState();
        const body = isOwner
          ? { owner: true, enabled: st.ids, vs: st.vs, plugins: list() }
          : { owner: false, enabled: st.ids, vs: st.vs };
        sendJson(req, res, 200, body);
        return;
      }
      if (req.method === 'POST') {
        if (!isOwner || !sameOriginWrite(req)) {
          sendJson(req, res, 403, { error: 'FORBIDDEN' });
          return;
        }
        let body;
        try { body = await readJsonBody(req); } catch {
          sendJson(req, res, 400, { error: 'BAD_JSON' });
          return;
        }
        if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
          sendJson(req, res, 400, { error: 'BAD_BODY' });
          return;
        }
        const r = setEnabled(body.id, body.enabled);
        if ('error' in r) { sendJson(req, res, r.status || 400, { error: r.error }); return; }
        sendJson(req, res, 200, { ok: true, owner: true, enabled: r.state.ids, vs: r.state.vs, plugins: r.plugins });
        return;
      }
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
    },
  };
}
