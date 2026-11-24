// Boss prep route geometry and sequential moving-trail sampler shared by the Pixi and simplified fields.
// Input points are [row, col] on the stage.
import { GEO } from '../../../shared/constants.js';

// [ASSUMED] Arknights-style moving crimson ribbon with numbered waypoint badges; tones keep the preview
// readable beside placement highlights without cluttering retraced corridors.
export const ROUTE_TONES = {
  approach: { color: 0xff6d5e, alpha: 0.85 },
  travel: { color: 0xff493d, alpha: 0.94 },
  patrol: { color: 0xff3b30, alpha: 0.98 },
};
export const ROUTE_OUTLINE = 0x2a0c10;
export const ROUTE_GLOW = 0xff2b22;
export const ROUTE_LIGHT = 0xffd5cc;

const PRIORITY = { approach: 1, travel: 2, patrol: 3 };
const MARK_PRIORITY = { waypoint: 1, wait: 2, portal: 3 };
const EPS = 1e-5;
const ROUTE_SPEED = 4.6; // world tiles per second
const PAUSE_DIST = 1.6;  // short breather after the tail drains before the next cycle
const pointKey = ([r, c]) => `${Math.round(r / EPS)},${Math.round(c / EPS)}`;
const samePoint = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const validPoint = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && p[0] >= -1 && p[0] <= GEO.ROWS && p[1] >= -1 && p[1] <= GEO.COLS;

/** Build continuous ordered polyline runs from raw route paths, breaking only at disjoint jumps (portals). */
function buildRuns(paths) {
  const points = new Map();
  const intern = (p) => {
    const key = pointKey(p);
    if (!points.has(key)) points.set(key, p);
    return points.get(key);
  };
  const runs = [];
  let current = null;
  for (const path of paths) {
    if (!Object.hasOwn(PRIORITY, path?.kind) || !Array.isArray(path.points)) continue;
    let prev = null;
    for (const raw of path.points) {
      if (!validPoint(raw)) { prev = null; current = null; continue; }
      const p = intern(raw);
      if (prev && prev !== p) {
        const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        if (len > EPS) {
          if (!current || !samePoint(current.end, prev)) {
            current = { segments: [], start: prev, end: prev };
            runs.push(current);
          }
          current.segments.push({ a: prev, b: p, kind: path.kind, len });
          current.end = p;
        }
      }
      prev = p;
    }
  }
  return { runs: runs.filter((r) => r.segments.length > 0), points };
}

/** Split at existing endpoints on the same line so reduced-motion static lanes can separate opposite directions. */
function splitEdge(a, b, points) {
  const dr = b[0] - a[0], dc = b[1] - a[1];
  const len = Math.hypot(dr, dc);
  const split = [{ at: 0, p: a }, { at: len, p: b }];
  for (const p of points) {
    if (p === a || p === b) continue;
    const r = p[0] - a[0], c = p[1] - a[1];
    const at = (r * dr + c * dc) / len;
    if (at > EPS && at < len - EPS && Math.abs(r * dc - c * dr) < EPS * len) split.push({ at, p });
  }
  return split.sort((x, y) => x.at - y.at).map(({ p }) => p);
}

/** Static offset strokes used only as the reduced-motion fallback so retraced corridors stay distinct. */
function buildStaticStrokes(runs, points) {
  const directed = new Map();
  for (const run of runs) {
    for (const seg of run.segments) {
      const split = splitEdge(seg.a, seg.b, points.values());
      for (let i = 1; i < split.length; i++) {
        const from = split[i - 1], to = split[i];
        const ka = pointKey(from), kb = pointKey(to);
        const key = `${ka}:${kb}`, reverse = `${kb}:${ka}`;
        const edge = { kind: seg.kind, a: from, b: to, reverse, len: Math.hypot(to[0] - from[0], to[1] - from[1]) };
        if (PRIORITY[seg.kind] > (PRIORITY[directed.get(key)?.kind] || 0)) directed.set(key, edge);
      }
    }
  }
  return [...directed.values()].map((e) => ({ ...e, both: directed.has(e.reverse) }));
}

export function buildBossRoute(route) {
  if (!Array.isArray(route?.paths)) return null;
  const { runs, points } = buildRuns(route.paths);
  if (!runs.length) return null;

  const rawLen = runs.reduce((sum, r) => sum + r.segments.reduce((s, seg) => s + seg.len, 0), 0);
  if (!(rawLen > EPS)) return null;
  const trailLen = Math.min(4.8, Math.max(1.8, rawLen * 0.34));
  const portalGap = Math.min(2.6, trailLen * 0.75);

  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    if (i > 0) cursor += portalGap;
    const run = runs[i];
    run.startDist = cursor;
    for (const seg of run.segments) {
      seg.startDist = cursor;
      cursor += seg.len;
      seg.endDist = cursor;
    }
    run.endDist = cursor;
  }
  const totalDist = cursor;
  const cycleDist = totalDist + trailLen + PAUSE_DIST;
  const initialOffset = Math.min(totalDist, Math.max(1.2, trailLen * 0.85));

  // Preserve first-visit order for waypoint numbering while upgrading coincident marks by priority.
  const markMap = new Map();
  for (const m of Array.isArray(route.marks) ? route.marks : []) {
    if (!Object.hasOwn(MARK_PRIORITY, m?.kind) || !validPoint(m.at)) continue;
    const key = pointKey(m.at);
    const prev = markMap.get(key);
    if (!prev) markMap.set(key, { kind: m.kind, at: m.at });
    else if (MARK_PRIORITY[m.kind] > MARK_PRIORITY[prev.kind]) prev.kind = m.kind;
  }

  let seq = 0;
  const marks = [];
  for (const m of markMap.values()) {
    const order = m.kind === 'portal' ? null : ++seq;
    const passDists = [];
    for (const run of runs) {
      for (const seg of run.segments) {
        if (samePoint(seg.a, m.at) && (!passDists.length || seg.startDist - passDists[passDists.length - 1] > 0.1)) {
          passDists.push(seg.startDist);
        }
        if (samePoint(seg.b, m.at) && (!passDists.length || seg.endDist - passDists[passDists.length - 1] > 0.1)) {
          passDists.push(seg.endDist);
        }
      }
    }
    marks.push({ ...m, order, passDists });
  }

  const staticStrokes = buildStaticStrokes(runs, points);
  return {
    runs,
    marks,
    staticStrokes,
    totalDist,
    trailLen,
    cycleDist,
    speed: ROUTE_SPEED,
    initialOffset,
  };
}

function chevronPoints(x, y, ux, uy, size) {
  return [
    { x: x - ux * size * 1.15 - uy * size * 0.72, y: y - uy * size * 1.15 + ux * size * 0.72 },
    { x: x + ux * size * 0.42, y: y + uy * size * 0.42 },
    { x: x - ux * size * 1.15 + uy * size * 0.72, y: y - uy * size * 1.15 - ux * size * 0.72 },
  ];
}

export function projectBossRoute(geometry, transform) {
  const cache = new Map();
  const project = (p) => {
    const key = pointKey(p);
    if (!cache.has(key)) cache.set(key, transform(p));
    return cache.get(key);
  };
  let scaleSum = 0;
  let scaleCount = 0;
  const runs = geometry.runs.map((run) => ({
    startDist: run.startDist,
    endDist: run.endDist,
    segments: run.segments.map((seg) => {
      const a = project(seg.a);
      const b = project(seg.b);
      scaleSum += (a.s + b.s) / 2;
      scaleCount++;
      const dx = b.x - a.x, dy = b.y - a.y;
      const screenLen = Math.hypot(dx, dy);
      return {
        ...seg,
        a,
        b,
        screenLen,
        ux: screenLen > 1e-4 ? dx / screenLen : 1,
        uy: screenLen > 1e-4 ? dy / screenLen : 0,
      };
    }),
  }));
  const scale = scaleCount ? scaleSum / scaleCount : 40;
  const width = Math.max(2.2, Math.min(scale * 0.058, 4.4));

  const marks = geometry.marks.map((mark) => {
    const p = project(mark.at);
    const radius = mark.kind === 'portal'
      ? Math.max(4.5, Math.min(8.5, p.s * 0.12))
      : Math.max(6.8, Math.min(11.2, p.s * 0.165));
    return { ...p, kind: mark.kind, order: mark.order, passDists: mark.passDists, radius };
  });

  const staticStrokes = [];
  const staticArrows = [];
  for (const edge of geometry.staticStrokes) {
    const pa = project(edge.a), pb = project(edge.b);
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const ux = dx / len, uy = dy / len;
    const off = edge.both ? Math.max(2.6, width * 1.15) : 0;
    const a = { x: pa.x - uy * off, y: pa.y + ux * off };
    const b = { x: pb.x - uy * off, y: pb.y + ux * off };
    staticStrokes.push({ a, b, kind: edge.kind, both: edge.both });
    if (len >= 10) {
      const size = Math.max(3.2, Math.min(scale * 0.1, 6.2, len * 0.32));
      staticArrows.push({
        kind: edge.kind,
        points: chevronPoints((a.x + b.x) / 2, (a.y + b.y) / 2, ux, uy, size),
      });
    }
  }

  return {
    runs,
    marks,
    staticStrokes,
    staticArrows,
    width,
    scale,
    totalDist: geometry.totalDist,
    trailLen: geometry.trailLen,
    cycleDist: geometry.cycleDist,
    speed: geometry.speed,
    initialOffset: geometry.initialOffset,
  };
}

function sampleRunPoint(run, dist) {
  for (const seg of run.segments) {
    if (dist <= seg.endDist + EPS) {
      const f = seg.len > EPS ? Math.max(0, Math.min(1, (dist - seg.startDist) / seg.len)) : 0;
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * f,
        y: seg.a.y + (seg.b.y - seg.a.y) * f,
        s: seg.a.s + (seg.b.s - seg.a.s) * f,
        ux: seg.ux,
        uy: seg.uy,
        kind: seg.kind,
      };
    }
  }
  const last = run.segments[run.segments.length - 1];
  return { x: last.b.x, y: last.b.y, s: last.b.s, ux: last.ux, uy: last.uy, kind: last.kind };
}

/**
 * Sample the active Arknights-style moving red ribbon, directional chevrons and waypoint pulse at `elapsedSec`.
 * Deterministic and shared by both Pixi and DOM SVG renderers.
 */
export function sampleBossRouteFrame(projected, elapsedSec = 0) {
  const { runs, marks, trailLen, cycleDist, speed, initialOffset } = projected;
  const raw = elapsedSec * speed + initialOffset;
  const cursor = ((raw % cycleDist) + cycleDist) % cycleDist;
  const tailDist = cursor - trailLen;
  const headDist = cursor;
  const maxStep = Math.max(0.18, trailLen / 20);

  const spans = [];
  const chevrons = [];
  const heads = [];

  for (const run of runs) {
    const lo = Math.max(run.startDist, tailDist);
    const hi = Math.min(run.endDist, headDist);
    if (hi - lo <= 1e-4) continue;

    for (const seg of run.segments) {
      const sLo = Math.max(seg.startDist, lo);
      const sHi = Math.min(seg.endDist, hi);
      if (sHi - sLo <= 1e-4) continue;
      const steps = Math.max(1, Math.ceil((sHi - sLo) / maxStep));
      for (let i = 0; i < steps; i++) {
        const d0 = sLo + (sHi - sLo) * (i / steps);
        const d1 = sLo + (sHi - sLo) * ((i + 1) / steps);
        const f0 = seg.len > EPS ? (d0 - seg.startDist) / seg.len : 0;
        const f1 = seg.len > EPS ? (d1 - seg.startDist) / seg.len : 1;
        spans.push({
          a: { x: seg.a.x + (seg.b.x - seg.a.x) * f0, y: seg.a.y + (seg.b.y - seg.a.y) * f0 },
          b: { x: seg.a.x + (seg.b.x - seg.a.x) * f1, y: seg.a.y + (seg.b.y - seg.a.y) * f1 },
          t0: Math.max(0, Math.min(1, (d0 - tailDist) / trailLen)),
          t1: Math.max(0, Math.min(1, (d1 - tailDist) / trailLen)),
          kind: seg.kind,
        });
      }
    }

    if (headDist >= run.startDist + 0.08 && headDist <= run.endDist + EPS) {
      const head = sampleRunPoint(run, Math.min(run.endDist, headDist));
      const size = Math.max(4.6, Math.min(head.s * 0.145, 9.2));
      heads.push({
        x: head.x,
        y: head.y,
        kind: head.kind,
        radius: Math.max(2.6, Math.min(head.s * 0.075, 4.8)),
        points: chevronPoints(head.x, head.y, head.ux, head.uy, size),
      });
    }

    for (const back of [1.35, 2.7]) {
      const d = headDist - back;
      if (d <= lo + 0.2 || d >= hi - 0.3) continue;
      const p = sampleRunPoint(run, d);
      const t = Math.max(0, Math.min(1, (d - tailDist) / trailLen));
      const size = Math.max(3.4, Math.min(p.s * 0.105, 6.8)) * (0.65 + 0.35 * t);
      chevrons.push({
        kind: p.kind,
        alpha: 0.25 + 0.7 * t * t,
        points: chevronPoints(p.x, p.y, p.ux, p.uy, size),
      });
    }
  }

  const markPulses = marks.map((mark) => {
    let best = 0;
    for (const d of mark.passDists) {
      let delta = cursor - d;
      if (delta < 0) delta += cycleDist;
      if (delta >= 0 && delta < 2.6) {
        const p = 1 - delta / 2.6;
        if (p * p > best) best = p * p;
      }
    }
    return best;
  });

  return { cursor, spans, heads, chevrons, markPulses };
}

/** Extra strokes at a wait or portal mark. The round badge of a waypoint/wait is drawn by the caller. */
export function routeMarkLines({ x, y, radius: r, kind }) {
  if (kind === 'portal') {
    return [[{ x, y: y - r }, { x: x + r, y }, { x, y: y + r }, { x: x - r, y }, { x, y: y - r }]];
  }
  if (kind === 'wait') {
    return [-1, 1].map((side) => [{ x: x + side * r * 1.05, y: y - r * 0.38 }, { x: x + side * r * 1.05, y: y + r * 0.38 }]);
  }
  return [];
}
