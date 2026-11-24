// Preparation geometry for the template's leader routes on the time-zero terrain.
import { GEO } from '../../shared/constants.js';
import { Battle } from './Battle.js';
import { routeLegPoints } from './ai.js';
import { fin } from './battle/util.js';
import { TICK } from './constants.js';
import { install as installDevices } from './content/devices.js';
import { bossMirrorSpawns, install as installBosses, isBossPatrolRoute, patrolResetAt } from './content/bosses.js';

const MID_COL = (GEO.BOSS_RECT.c0 + GEO.BOSS_RECT.c1) / 2;
const WAIT_MARK_SECONDS = 1; // [ASSUMED] Short stops add no visible wait mark.
const halfOf = (col) => col < MID_COL ? 'L' : col > MID_COL ? 'R' : null;
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const spawnTime = (time) => Math.max(0, fin(time, 0));
const tickOf = (time) => Math.ceil((spawnTime(time) - 1e-9) / TICK);
const quiet = { log() {}, warn() {}, error() {} };

/**
 * @param {object} opts Battle options, including the field's scheduled `spawns`, plus the viewing player's `side`.
 * @param {object} [simData] The version's sim data or DataSource, as passed to Battle.
 * @returns {{paths: {kind: 'approach'|'patrol'|'travel', points: number[][]}[], marks: {kind: 'waypoint'|'wait'|'portal', at: number[]}[]}|null}
 */
export function buildBossRoutePreview(opts, simData) {
  if (opts?.kind !== 'boss' && opts?.kind !== 'hidden') return null;
  const spawns = (opts.spawns ?? []).filter((s) => s?.tag === 'boss' && Number(s.time) !== Infinity);
  if (!spawns.length) return null;
  const probe = new Battle({
    ...opts, data: simData ?? opts.data, spawns: [], sharedBoss: null, recordEvents: false, logger: quiet,
    content: 'none', extraContent: [installDevices, installBosses], setup: null,
  });
  // Only install the initial terrain and device state. Enemy kits run their spawn hooks below, with no battle ticks.
  probe.start();
  const leaders = leaderCandidates(probe, spawns);
  const side = opts.side === 'R' ? 'R' : 'L';
  const paths = [], marks = [];
  for (const leader of leaders) {
    const e = leader.enemy;
    if (e.buffs.some((buff) => buff.flags?.noMove && buff.duration === Infinity) || e.s.moveSpeed <= 0) continue;
    const route = traceRoute(probe, e);
    if (!route.paths.length || !belongsToSide(probe, leader, leaders.length, route, side)) continue;
    paths.push(...route.paths);
    marks.push(...route.marks.values());
  }
  return paths.length ? { paths, marks } : null;
}

function leaderCandidates(b, spawns) {
  const candidates = spawns.slice().sort((a, z) => spawnTime(a.time) - spawnTime(z.time)).map((spawn) => ({
    spawn,
    side: spawn.ownerPlayerId == null ? null : b.players.find((p) => p.playerId === spawn.ownerPlayerId)?.half,
    enemy: b.spawnEnemy(spawn.enemyKey, spawn),
  })).filter(({ enemy }) => enemy);
  const generated = [];
  const seen = new Set();
  for (const main of candidates) {
    const key = main.enemy.defId;
    if (seen.has(key)) continue;
    seen.add(key);
    const branches = bossMirrorSpawns(b, main.enemy);
    if (!branches?.length) continue;
    const scheduled = candidates.filter(({ enemy }) => enemy.defId === key);
    // Scheduled callbacks run before the regular spawns, and cannot run on the tick that scheduled them.
    for (const branch of branches.slice().sort((a, z) => spawnTime(a.time) - spawnTime(z.time))) {
      const tick = Math.max(tickOf(main.spawn.time) + 1, tickOf(branch.time));
      const liveCount = scheduled.reduce((count, { spawn }) => {
        const time = spawnTime(spawn.time);
        if (tickOf(time) >= tick) return count;
        const second = fin(spawn.count, 1) >= 2 && tickOf(time + spawnTime(spawn.interval)) < tick;
        return count + (second ? 2 : 1);
      }, 0);
      if (liveCount >= 2) break;
      const enemy = b.spawnEnemy(key, { route: branch.route, tag: 'boss', mods: main.enemy.mods });
      if (enemy) {
        main.side ??= 'L';
        generated.push({ enemy, side: 'R' });
        break;
      }
    }
  }
  return candidates.concat(generated);
}

function belongsToSide(b, { side: owner, enemy }, count, route, side) {
  if (b.players.length < 2) return true;
  if (count > 1) {
    // [ASSUMED] An independently scheduled copy on the center column follows its first off-center checkpoint.
    const assigned = owner ?? halfOf(enemy.spawnX) ?? route.departure;
    return assigned == null || assigned === side;
  }
  if (owner === side || halfOf(enemy.spawnX) === side) return true;
  const halves = new Set(route.paths.flatMap((path) => path.points.map(([, col]) => halfOf(col))));
  return halves.has(side) || (!halves.has('L') && !halves.has('R'));
}

function traceRoute(b, e) {
  const trace = { at: [e.spawnY, e.spawnX], hidden: false, departure: null, path: null, paths: [], marks: new Map(), edges: new Set() };
  const legs = e.route.legs;
  const resetAt = isBossPatrolRoute(b, e) ? patrolResetAt(legs) : null;
  if (resetAt == null) {
    traceLegs(b.grid, e.motion, trace, legs, 'travel');
  } else {
    const loop = legs.slice(0, resetAt);
    const firstMove = loop.findIndex((leg) => leg.t === 'move');
    if (firstMove >= 0) {
      const approach = loop.slice(0, firstMove + 1);
      traceLegs(b.grid, e.motion, trace, approach, 'approach');
      trace.path = null;
      // The first checkpoint ends the approach. Follow the remaining legs, then re-plan the first leg from the
      // last checkpoint to close the loop. In combat the tick budget can briefly enter the final leg before reset.
      traceLegs(b.grid, e.motion, trace, loop.slice(firstMove + 1), 'patrol');
      traceLegs(b.grid, e.motion, trace, approach, 'patrol');
    }
  }
  return trace;
}

function traceLegs(grid, motion, trace, legs, kind) {
  for (const leg of legs) {
    if (leg.t === 'wait') {
      if (!trace.hidden && leg.time >= WAIT_MARK_SECONDS) mark(trace, 'wait');
    } else if (leg.t === 'disappear') {
      if (!trace.hidden) mark(trace, 'portal');
      trace.path = null;
      trace.hidden = true;
    } else if (leg.t === 'appear') {
      trace.path = null;
      trace.at = [leg.r, leg.c];
      trace.departure ??= halfOf(leg.c);
      trace.hidden = false;
      mark(trace, 'portal');
    } else {
      if (!trace.hidden) trace.departure ??= halfOf(leg.c);
      const [r, c] = trace.at;
      const points = routeLegPoints(grid, motion, c, r, leg);
      for (const { x, y } of points) moveTo(trace, kind, [y, x]);
      if (!trace.hidden && !leg.final) mark(trace, 'waypoint');
    }
  }
}

function mark(trace, kind) {
  const key = `${kind}:${trace.at.join(',')}`;
  if (!trace.marks.has(key)) trace.marks.set(key, { kind, at: trace.at });
}

function moveTo(trace, kind, at) {
  const from = trace.at;
  if (samePoint(from, at)) return;
  trace.at = at;
  if (trace.hidden) return;
  const edge = `${kind}:${from.join(',')}/${at.join(',')}`;
  if (trace.edges.has(edge)) {
    trace.path = null;
    return;
  }
  trace.edges.add(edge);
  if (trace.path) {
    trace.path.points.push(at);
  } else {
    trace.path = { kind, points: [from, at] };
    trace.paths.push(trace.path);
  }
}
