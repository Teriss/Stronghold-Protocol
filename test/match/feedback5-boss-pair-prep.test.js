// Community report of 2026-10-06, item 51: 「还原原版最终boss战准备阶段：像战斗中那样把会成一组的两个玩家放在一起（靠右边的
// 那个他自己的视角就是靠右，他之前的摆位也镜像过去，干员位置面向相对boss是不变的），同组两个玩家屏幕左边的头像也像原版那样用绿框
// 框起来」. The own half (mirrored for the right-hand player, RIGHT ↔ LEFT) and its camera were already the official ones
// (research 09 §1.2, DESIGN §15); missing were the partner's pieces on the other half and the frames. Now m.private
// carries `bossMate` in a boss round's prep — the partner's board on its half as the battle places it — kept current
// when the partner moves (the partner's m.private is marked with the mover's), a scout of either player shows both
// halves, and the team panel frames the pair (gameLogic teamFrameIds). Overlap: PR #191 (same-field frames, issue #190)
// published the pairing as m.public bossPairing and framed the partner alone in gold — not merged; here the client reads
// the pairing as prepCamera already does, and both avatars get the official green frame (ui/battle bg_team_border).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, give, legalTileFor, chessOfTier } from './harness.js';
import { bossFieldPlacement } from '../../server/match/finalAssault.js';
import { getVersionData } from '../../server/data.js';
import { teamFrameIds } from '../../public/js/ui/gameLogic.js';

function bossPrep(humans, seed) {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans, seed, fake: true }).start();
  const m = h.m;
  // Explicit layout fixture: these cases test mirrored metadata, not the random draw (covered separately).
  const ids = m.order.map(p => p.playerId);
  m.bossPairs = [ids.slice(0, 2), ids.slice(2)].filter(g => g.length);
  h.drive(() => m.phase === PHASE.PREP && m.round === m.gd.bossRound, { ready: true });
  for (const ps of m.players.values()) { ps.ready = false; for (const k of [...ps.board.keys()]) ps.board.delete(k); ps.recompute(); }
  m.flush(true);
  return h;
}
const place = (h, pid, id) => {
  const ps = h.ps(pid);
  const tile = legalTileFor(h.m, ps, id);
  const piece = give(h.m, ps, id, 'board', tile);
  piece.dir = 'RIGHT';
  ps.recompute();
  return { piece, tile };
};

test('m.private bossMate: each player of a pair gets the other\'s board on its half — mirrored on the right, facing kept', () => {
  const h = bossPrep(4, 5101);
  const m = h.m;
  assert.deepEqual(m.bossWaves.map((w) => w.players), [['p_0', 'p_1'], ['p_2', 'p_3']]);
  const a = place(h, 'p_0', chessOfTier(1)[0]);
  const b = place(h, 'p_1', chessOfTier(1)[1]);
  m.flush(true);
  const v0 = h.ps('p_0').privateView();
  const v1 = h.ps('p_1').privateView();
  assert.deepEqual([v0.bossMate.playerId, v0.bossMate.side], ['p_1', 'R']);
  assert.deepEqual([v1.bossMate.playerId, v1.bossMate.side], ['p_0', 'L']);
  const onR = v0.bossMate.units.find((u) => u.uid === b.piece.uid);
  const wantR = bossFieldPlacement('R', b.tile[0], b.tile[1], 'RIGHT');
  assert.deepEqual([onR.y, onR.x, onR.dir, onR.facing, onR.ownerId], [wantR.row, wantR.col, 'LEFT', -1, 'p_1'], 'the right half: mirrored, still facing the leader');
  const onL = v1.bossMate.units.find((u) => u.uid === a.piece.uid);
  const wantL = bossFieldPlacement('L', a.tile[0], a.tile[1], 'RIGHT');
  assert.deepEqual([onL.y, onL.x, onL.dir, onL.ownerId], [wantL.row, wantL.col, 'RIGHT', 'p_0'], 'the left half as it is');
  assert.equal(v0.bossMate.units.length, 1, 'the partner\'s board only (its bench stays its own)');
  m.dispose();
});

test('a move of the partner reaches the player\'s m.private and a scout of either player at once', () => {
  const h = bossPrep(4, 5102);
  const m = h.m;
  const b = place(h, 'p_1', chessOfTier(1)[1]);
  const held = give(m, h.ps('p_0'), chessOfTier(1)[2]); // into p_0's hand
  m.flush(true);
  // p_3 (eliminated) scouts p_0: the scout shows p_0's half and p_1's board on the other half
  h.ps('p_3').eliminate(13);
  assert.deepEqual(m.handle('p_3', { t: 'g.watch', fieldId: 'n:p_0' }), { ok: true });
  let scout = h.lastTo('p_3', 'm.field');
  assert.deepEqual([scout.kind, scout.side, scout.mate], ['boss', 'L', { playerId: 'p_1', side: 'R' }]);
  assert.ok(scout.units.some((u) => u.uid === b.piece.uid && u.x >= 10), 'the partner\'s piece on the right half');
  // the area tags survive the boss-half remap (the rows do not): the bond popup tells the bench from the board (GitHub #385)
  assert.equal(scout.units.find((u) => u.uid === b.piece.uid).area, 'board');
  assert.equal(scout.units.find((u) => u.uid === held.uid).area, 'hand', 'a held operator stays tagged as held');
  // p_1 moves its piece: p_0's m.private and p_3's scout of p_0 follow
  const ps1 = h.ps('p_1');
  const to = legalTileFor(m, ps1, b.piece.id, new Set([`${b.tile[0]},${b.tile[1]}`]));
  const before = h.allTo('p_3', 'm.field').length;
  assert.deepEqual(m.handle('p_1', { t: 'g.move', uid: b.piece.uid, to: { area: 'board', row: to[0], col: to[1] }, dir: 'UP' }), { ok: true });
  m.flush(true);
  const want = bossFieldPlacement('R', to[0], to[1], 'UP');
  const u0 = h.lastTo('p_0', 'm.private').bossMate.units.find((u) => u.uid === b.piece.uid);
  assert.deepEqual([u0.y, u0.x, u0.dir], [want.row, want.col, 'UP']);
  assert.ok(h.allTo('p_3', 'm.field').length > before, 'the scout of p_0 was pushed again');
  scout = h.lastTo('p_3', 'm.field');
  const us = scout.units.find((u) => u.uid === b.piece.uid);
  assert.deepEqual([us.y, us.x, us.dir], [want.row, want.col, 'UP']);
  m.dispose();
});

test('no bossMate for a lone player, outside a boss round\'s prep, or once the fight is on', () => {
  const h = bossPrep(3, 5103);
  const m = h.m;
  assert.deepEqual(m.bossWaves.map((w) => w.players), [['p_0', 'p_1'], ['p_2']]);
  assert.equal(h.ps('p_2').privateView().bossMate, undefined, 'the lone player of a 3-player Final Assault');
  assert.ok(h.ps('p_0').privateView().bossMate, 'the pair has one');
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  assert.equal(h.ps('p_0').privateView().bossMate, undefined, 'the fight: the boss field itself is shown');
  m.dispose();
  const h2 = makeMatch({ mode: 'coop', humans: 2, seed: 5104, fake: true }).start();
  h2.toPrep(1);
  assert.equal(h2.ps('p_0').privateView().bossMate, undefined, 'a normal round');
  h2.m.dispose();
});

function regulationBossPrep(t, { hidden = false, bossId = 'boss_2' } = {}) {
  const data = getVersionData('act3autochess@V3_1');
  const h = makeMatch({ data, mode: 'coop', modeId: 'mode_multi_normal', humans: 4, seed: 5105, fake: true }).start();
  const m = h.m;
  t.after(() => m.dispose());
  h.toPrep(1);
  assert.equal(h.lastTo('p_0', 'm.private').bossRoute, undefined);
  h.setStage('act3autochess_m03');
  m.bossId = bossId;
  m.hiddenBossId = 'boss_9';
  m.bossPairs = [['p_0', 'p_1'], ['p_2', 'p_3']];
  const round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
  m.startRound(round);
  h.toPrep(round);
  m.flush(true);
  return h;
}

test('the Final Assault publishes the prepared leader route for the recipient or scouted half', (t) => {
  const h = regulationBossPrep(t);
  const { m } = h;
  const p1 = h.ps('p_1');
  const left = h.lastTo('p_0', 'm.private').bossRoute;
  const right = h.lastTo('p_1', 'm.private').bossRoute;
  assert.deepEqual(left.paths[0].points[0], [4, 10]);
  assert.deepEqual(right.paths[0].points[0], [4, 10]);
  assert.deepEqual(left.marks[0].at, [5, 9]);
  assert.deepEqual(right.marks[0].at, [3, 11]);
  assert.equal(h.lastBc('m.public').bossRoute, undefined);
  assert.deepEqual(m.handle('p_2', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  assert.strictEqual(h.lastTo('p_2', 'm.field').bossRoute, right);

  m.onLeave('p_0');
  assert.equal(m.bossGroupOf(p1).wave.templateId, 'act3autochess_h07_02_s');
  const replanned = h.lastTo('p_1', 'm.private').bossRoute;
  assert.deepEqual(replanned.marks[0].at, [5, 9]);
  assert.strictEqual(h.lastTo('p_2', 'm.field').bossRoute, replanned);
  m.onDisconnect('p_1');
  m.onReconnect('p_1');
  assert.strictEqual(h.lastTo('p_1', 'm.private').bossRoute, replanned);

  assert.ok(h.drive(() => m.phase === PHASE.FINAL_ASSAULT));
  assert.equal(h.lastTo('p_1', 'm.private').bossRoute, undefined);
  assert.equal(m.prepFieldMeta(p1).bossRoute, undefined);
});

test('prep route caching follows effective device overrides and refreshes the scout after a change', (t) => {
  const h = regulationBossPrep(t);
  const { m } = h;
  const p1 = h.ps('p_1');
  const right = h.lastTo('p_1', 'm.private').bossRoute;
  assert.deepEqual(m.handle('p_2', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  place(h, 'p_1', chessOfTier(1)[0]);
  assert.strictEqual(p1.privateView().bossRoute, right);

  // This platform at boss tile [3, 16] redirects the right-hand branch of 铳's patrol.
  const platform = 'trap_1106_achplat#1';
  p1.deviceOverrides[platform] = false;
  p1.invalidateDeployMap();
  const updated = m.bossRouteFor(p1);
  assert.notDeepEqual(updated, right);
  assert.equal(p1._legalityStale, true, 'reading the preview leaves board legality for the prep mutation path');
  p1.recompute();
  m.flush(true);
  assert.strictEqual(h.lastTo('p_1', 'm.private').bossRoute, updated);
  assert.strictEqual(h.lastTo('p_2', 'm.field').bossRoute, updated);
});

test('the Hidden Core uses its own wave and a stationary leader has no route field', (t) => {
  const hidden = regulationBossPrep(t, { hidden: true });
  const ps = hidden.ps('p_0');
  assert.equal(hidden.m.bossGroupOf(ps).wave.templateId, 'act3autochess_h08_02');
  const route = hidden.lastTo('p_0', 'm.private').bossRoute;
  assert.ok(route.paths.some(({ kind }) => kind === 'patrol'));
  assert.strictEqual(hidden.m.prepFieldMeta(ps).bossRoute, route);
  const stationary = regulationBossPrep(t, { bossId: 'boss_4' });
  assert.equal(stationary.lastTo('p_0', 'm.private').bossRoute, undefined);
  assert.equal(stationary.m.prepFieldMeta(stationary.ps('p_0')).bossRoute, undefined);
});

test('client: teamFrameIds frames the viewer\'s pair in a boss round (prep and fight), nobody otherwise', () => {
  const players = [0, 1, 2, 3].map((i) => ({ playerId: `p_${i}`, seat: i, alive: true }));
  const pub = (o) => ({ round: 14, bossRound: 14, hiddenRound: 15, phase: PHASE.PREP, players, fields: [], ...o });
  const ids = (s) => [...s].sort();
  assert.deepEqual(ids(teamFrameIds(pub({}), 'p_0')), ['p_0', 'p_1']);
  assert.deepEqual(ids(teamFrameIds(pub({}), 'p_3')), ['p_2', 'p_3']);
  assert.deepEqual(ids(teamFrameIds(pub({ phase: PHASE.ROUND_START }), 'p_2')), ['p_2', 'p_3'], 'from the round start');
  assert.deepEqual(ids(teamFrameIds(pub({ phase: PHASE.SP_DRAFT, round: 15 }), 'p_1')), ['p_0', 'p_1'], 'the Hidden Core prep');
  // seat 1 out: the players still in pair by seat (p_0, p_2), p_3 alone
  const out = players.map((p) => (p.playerId === 'p_1' ? { ...p, alive: false } : p));
  assert.deepEqual(ids(teamFrameIds(pub({ players: out }), 'p_2')), ['p_0', 'p_2']);
  assert.deepEqual(ids(teamFrameIds(pub({ players: out }), 'p_3')), [], 'a lone player: no frame');
  assert.deepEqual(ids(teamFrameIds(pub({ players: out }), 'p_1')), [], 'an eliminated viewer: no pair');
  assert.deepEqual(ids(teamFrameIds(pub({ round: 13 }), 'p_0')), [], 'a normal round');
  assert.deepEqual(ids(teamFrameIds(pub({}), 's_spec')), [], 'a spectator seat');
  const fight = pub({ phase: PHASE.FINAL_ASSAULT, fields: [{ fieldId: 'b1', kind: 'boss', players: ['p_0', 'p_1'] }, { fieldId: 'b2', kind: 'boss', players: ['p_2'] }] });
  assert.deepEqual(ids(teamFrameIds(fight, 'p_1')), ['p_0', 'p_1'], 'the fight: the boss field listing the viewer');
  assert.deepEqual(ids(teamFrameIds(fight, 'p_2')), [], 'a lone boss field');
  assert.deepEqual(ids(teamFrameIds(pub({ phase: PHASE.UNITE, round: 12 }), 'p_0')), [], '联防 is not framed (the owner asked for the boss rounds)');
});
