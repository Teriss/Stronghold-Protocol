
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { Match } from '../server/match/Match.js';
import { GameData } from '../server/match/gamedata.js';
import { wireOptions } from '../server/match/host/proxy.js';
import { bossPoolHp, pairPlayers } from '../server/match/finalAssault.js';
import { endlessMultiplier } from '../server/match/match/endless.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { bountySpawns } from '../server/match/waves.js';
import { getData } from '../server/data.js';
import { chatText } from '../shared/chat.js';
import { validateC2S } from '../shared/protocol.js';
import { PHASE } from '../shared/constants.js';
import { normalizeSp } from '../public/js/ui/gameLogic/draft.js';

async function client(t, server, name, token = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  const find = async (predicate) => {
    for (let i = 0; i < 300; i++) {
      const frame = frames.find(predicate);
      if (frame) return frame;
      await delay(10);
    }
    assert.fail(`${name} did not receive a frame (${frames.map((f) => f.t).slice(-15).join(', ')})`);
  };
  let rid = 0;
  const request = async (type, fields = {}) => {
    const id = ++rid;
    ws.send(JSON.stringify({ t: type, rid: id, ...fields }));
    return find((f) => f.rid === id);
  };
  const welcome = await request('hello', { name, version: 1, ...(token ? { token } : {}) });
  assert.equal(welcome.t, 'welcome');
  return { ws, frames, request, find, welcome, state: () => frames.findLast((f) => f.t === 'room.state') };
}

test('room capacity and private chat on real WebSocket connections', { timeout: 20000 }, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false,
    versions: { enabled: ['act2autochess'] } });
  t.after(async () => {
    for (const socket of server.wss.clients || []) socket.terminate();
    await server.close();
  });
  const host = await client(t, server, 'Host');
  assert.equal((await host.request('room.create', { mode: 'coop', capacity: 5 })).t, 'error');
  assert.equal((await host.request('room.create', { mode: 'coop', capacity: 8, difficulty: 'HARD' })).t, 'ok');
  const { code, seats } = await host.find((f) => f.t === 'room.state' && f.capacity === 8);
  assert.equal(seats.length, 8);

  const team = [host];
  for (let i = 2; i <= 8; i++) {
    const peer = await client(t, server, `P${i}`);
    team.push(peer);
    assert.equal((await peer.request('room.join', { code })).t, 'ok');
    assert.equal((await peer.request('room.ready', { ready: true })).t, 'ok');
  }
  const outside = await client(t, server, 'Outside');
  assert.equal((await outside.request('room.join', { code })).code, 'ROOM_FULL');
  assert.equal((await outside.request('room.create', { mode: 'coop', capacity: 6 })).t, 'ok');
  assert.equal((await outside.find((f) => f.t === 'room.state' && f.capacity === 6)).seats.length, 6);
  assert.equal((await outside.request('room.start')).t, 'ok');
  const outsideRoom = await outside.find((f) => f.t === 'room.state' && f.chatId);

  const spectator = await client(t, server, 'Spectator');
  assert.equal((await spectator.request('room.spectate', { code })).t, 'ok');
  assert.equal((await host.request('room.start')).t, 'ok');
  const active = await host.find((f) => f.t === 'room.state' && f.chatId);
  const match = server.lobby.rooms.get(code).match;
  const player = team.at(-1);
  await player.find((f) => f.t === 'room.state' && f.chatId === active.chatId);
  assert.equal(match.order.length, 8);
  assert.equal(match.gd.teamScale, 2);
  assert.equal((await outside.request('g.chat', { matchId: outsideRoom.chatId, text: 'other room' })).t, 'ok');
  assert.equal((await spectator.request('g.chat', { matchId: active.chatId, text: 'watcher' })).code, 'SPECTATOR');
  assert.equal((await player.request('g.chat', { matchId: outsideRoom.chatId, text: 'wrong match' })).code, 'WRONG_PHASE');
  assert.equal((await player.request('g.chat', { matchId: active.chatId, text: '  局域网 <b> P8  ' })).t, 'ok');
  const line = await host.find((f) => f.t === 'm.chat');
  assert.equal(line.message.text, '局域网 <b> P8');
  assert.equal(line.message.name, 'P8');
  assert.equal(line.message.playerId, player.welcome.playerId);
  assert.equal((await player.request('g.chat', { matchId: active.chatId, text: 'too soon' })).code, 'RATE');
  assert.equal(spectator.frames.some((f) => f.t.startsWith('m.chat')), false);
  assert.equal(outside.frames.some((f) => f.matchId === active.chatId), false);

  player.ws.close();
  await once(player.ws, 'close');
  const resumed = await client(t, server, 'P8', player.welcome.token);
  assert.equal(resumed.welcome.resumed, true);
  const history = await resumed.find((f) => f.t === 'm.chat.history');
  assert.deepEqual(history.messages, [line.message]);

  match.guard(() => { match.round = 3; match.enterSpDraft(); });
  assert.equal(match.sp.family, 'bounty');
  const pickers = [];
  for (let i = 0; i < 2; i++) {
    const id = match.spTurn();
    const picker = [...team.slice(0, -1), resumed].find((c) => c.welcome.playerId === id);
    assert.equal((await picker.request('g.choice', { idx: 0 })).t, 'ok');
    pickers.push(id);
  }
  resumed.ws.close();
  await once(resumed.ws, 'close');
  const afterPick = await client(t, server, 'P8', resumed.welcome.token);
  const snapshot = await afterPick.find((f) => f.t === 'm.public' && f.sp?.family === 'bounty');
  assert.deepEqual(normalizeSp(snapshot.sp).cards[0].pickers, pickers);

  match.finish({ victory: false });
  const result = await host.find((f) => f.t === 'm.result');
  assert.equal(result.players.length, 8);
  assert.equal((await host.request('g.chat', { matchId: active.chatId, text: 'late' })).code, 'WRONG_PHASE');
});

test('large matches cover every active seat in the draft, leader pairs and overview', () => {
  const data = getData();
  const modeId = 'mode_multi_funny';
  const base = new GameData(data, modeId, 4);
  for (const count of [4, 7, 8]) {
    const seats = Array.from({ length: count }, (_, seat) => ({
      seat, name: `P${seat + 1}`, playerId: `p${seat + 1}`, isBot: seat > 0, connected: true,
    }));
    const m = new Match({ data, modeId, mode: 'coop', difficulty: 'FUNNY', seed: 22, seats,
      send() {}, broadcast() {}, onEnd() {} });
    try {
      assert.equal(m.gd.teamScale, Math.max(1, count / 4));
      const id = base.visibleChess[0];
      assert.equal(m.gd.poolCopies(id), Math.ceil(base.poolCopies(id) * m.gd.teamScale));
      assert.equal(m.gd.bossPoolShare(count), count);
      assert.equal(m.gd.hiddenCore.multi, Math.ceil(base.hiddenCore.multi * m.gd.teamScale));
      const pairs = pairPlayers(m.order, { shuffle: (a) => a });
      assert.equal(pairs.length, Math.ceil(count / 2));
      assert.equal(pairs.at(-1).length, count % 2 ? 1 : 2);
      const player = m.order.at(-1);
      player.shop.level = 4;
      assert.equal(m.publicView().players.at(-1).shopLevel, 4);
      assert.deepEqual(m.publicView().players.at(-1).lineup, []);
      player.board.set('9,4', { uid: 1001, id, kind: 'chess', items: [] });
      const live = m.publicView().players.at(-1).lineup;
      assert.equal(live[0]?.id, id);
      m.captureOverviewLineups();
      player.board.clear();
      m.phase = PHASE.COMBAT;
      assert.deepEqual(m.publicView().players.at(-1).lineup, live);
      m.phase = PHASE.PREP;
      assert.deepEqual(m.publicView().players.at(-1).lineup, []);

      m.round = 3;
      m.enterSpDraft();
      const sized = m.sp.cards.length;
      assert.ok(count <= 4 ? sized <= 6 : sized >= count);
      const draft = m.sp;
      for (let i = 0; i < count; i++) {
        const pid = m.spTurn();
        const card = draft.cards.find((c) => m.spCardAvailable(c));
        assert.ok(card, `pick ${i + 1} of ${count}`);
        assert.equal(m.pickCard(m.players.get(pid), card.idx).ok, true);
      }
      assert.equal(Object.keys(draft.picks).length, count);
    } finally { m.dispose(); }
  }
});

test('wire validation allows the expanded index and counts Unicode chat characters', () => {
  assert.equal(chatText('🙂'.repeat(160)), '🙂'.repeat(160));
  assert.equal(chatText('🙂'.repeat(161)), null);
  assert.equal(chatText(' \t'), null);
  assert.equal(validateC2S({ t: 'g.choice', idx: 9 }), null);
  assert.notEqual(validateC2S({ t: 'g.choice', idx: 10 }), null);
  assert.equal(validateC2S({ t: 'room.kick', seat: 7, playerId: 'p8' }), null);
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', prepUnlimited: true }), null);
  assert.notEqual(validateC2S({ t: 'room.create', mode: 'coop', prepUnlimited: 'true' }), null);
  assert.deepEqual(wireOptions({ mode: 'coop', prepUnlimited: true }), { mode: 'coop', prepUnlimited: true });
});

test('only 6–8 opening seats can share a bounty card, preserving the original draft and independent spawns', () => {
  for (const count of [4, 5, 6, 7, 8]) {
    const seats = Array.from({ length: count }, (_, seat) => ({
      seat, name: `P${seat + 1}`, playerId: `p${seat + 1}`, isBot: seat === count - 1, connected: true,
    }));
    const scheduler = new VirtualScheduler();
    const m = new Match({ data: getData(), modeId: 'mode_multi_hard', mode: 'coop', difficulty: 'HARD',
      seed: 22, seats, aiPicksLast: true, scheduler, send() {}, broadcast() {}, onEnd() {} });
    try {
      m.startRound(3);
      assert.equal(scheduler.runUntil(() => m.phase === PHASE.SP_DRAFT, { maxTime: 5000 }), true);
      assert.ok(m.deadline > 0);
      const draft = m.sp;
      assert.equal(draft.family, 'bounty');
      assert.equal(draft.cards.length, 6);
      assert.ok(draft.cards.every((card) => card.kind === 'bounty'));
      const funds = new Map(m.order.map((p) => [p.playerId, p.funds]));
      const card = draft.cards[0];
      const first = m.players.get(m.spTurn());
      assert.equal(m.pickCard(first, card.idx).ok, true);
      assert.equal(m.pickCard(first, card.idx).error, 'ALREADY');
      const second = m.players.get(m.spTurn());
      const afterFirst = normalizeSp(m.publicView().sp);
      assert.deepEqual(afterFirst.cards[card.idx].pickers, [first.playerId]);
      assert.equal(afterFirst.cards[card.idx].exhausted, count < 6);
      if (count >= 6) {
        assert.equal(m.pickCard(second, card.idx).ok, true);
        const afterSecond = normalizeSp(m.publicView().sp);
        assert.deepEqual(afterSecond.cards[card.idx].pickers, [first.playerId, second.playerId]);
        assert.equal(afterSecond.cards[card.idx].exhausted, true);
        assert.equal(m.pickCard(m.players.get(m.spTurn()), card.idx).error, 'SOLD_OUT');
        const bountyIds = [first, second].map((p) => {
          assert.equal(p.bounties.length, 1);
          const spawns = bountySpawns(m.gd, m.round, m.wave, p.bounties, p.playerId);
          assert.ok(spawns.length > 0);
          assert.ok(spawns.every((s) => s.enemyKey === card.enemyKey && s.ownerPlayerId === p.playerId));
          return spawns[0].mods.bountyId;
        });
        assert.notEqual(...bountyIds);
      } else {
        assert.equal(m.pickCard(second, card.idx).error, 'SOLD_OUT');
      }
      for (let ps = m.players.get(m.spTurn()); ps && !ps.isBot; ps = m.players.get(m.spTurn())) {
        const next = draft.cards.find((c) => m.spCardAvailable(c));
        assert.ok(next);
        assert.equal(m.pickCard(ps, next.idx).ok, true);
      }
      assert.equal(scheduler.runUntil(() => m.phase === PHASE.PREP, { maxTime: 5000 }), true);
      assert.equal(Object.keys(draft.picks).length, count);
      assert.ok(m.order.every((p) => p.funds === funds.get(p.playerId) && p.bounties.length === 1));
      assert.equal(m.errorCount, 0);
    } finally { m.dispose(); }
  }
});

test('untimed preparation waits for all remaining players on real WebSocket connections', { timeout: 20000 }, async (t) => {
  class ClockedMatch extends Match {
    constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: false }) }); }
  }
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false,
    MatchClass: ClockedMatch, versions: { enabled: ['act2autochess'] } });
  t.after(async () => {
    for (const socket of server.wss.clients || []) socket.terminate();
    await server.close();
  });
  const host = await client(t, server, 'Host');
  let peer = await client(t, server, 'Peer');
  assert.equal((await host.request('room.create', { mode: 'solo', prepUnlimited: true })).code, 'BAD_MSG');
  for (const unlimited of [true, false]) {
    assert.equal((await host.request('room.create', { mode: 'coop', capacity: 6, ...(unlimited ? { prepUnlimited: true } : {}) })).t, 'ok');
    const { code, prepUnlimited } = host.state();
    assert.equal(!!prepUnlimited, unlimited);
    assert.equal((await peer.request('room.join', { code })).t, 'ok');
    assert.equal(!!peer.state().prepUnlimited, unlimited);
    assert.equal((await peer.request('room.ready', { ready: true })).t, 'ok');
    assert.equal((await host.request('room.start')).t, 'ok');
    const m = server.lobby.rooms.get(code).match;
    const prep = (round) => {
      m.guard(() => m.startRound(round));
      assert.equal(m.sched.runUntil(() => m.phase === PHASE.PREP, { maxTime: 5000 }), true);
      m.flush(true);
    };
    prep(1);
    const frame = await peer.find((f) => f.t === 'm.public' && f.phase === PHASE.PREP && f.round === 1 && !!f.prepUnlimited === unlimited);
    assert.equal(frame.deadline === 0, unlimited);
    if (!unlimited) {
      m.sched.advance(frame.deadline - m.sched.now());
      assert.equal(m.phase, PHASE.COMBAT);
      assert.equal(m.errorCount, 0);
      break;
    }
    assert.equal((await host.request('g.ready', { ready: true })).t, 'ok');
    m.sched.advance((m.gd.prepTime(1) + 1) * 1000);
    assert.equal(m.phase, PHASE.PREP);
    assert.equal((await peer.request('g.ready', { ready: true })).t, 'ok');
    assert.equal((await host.request('g.ready', { ready: false })).t, 'ok');
    m.sched.advance(0);
    assert.equal(m.phase, PHASE.PREP);
    assert.equal((await host.request('g.ready', { ready: true })).t, 'ok');
    assert.equal(m.sched.runUntil(() => m.phase === PHASE.COMBAT, { maxTime: 10 }), true);

    prep(m.gd.bossRound);
    assert.equal((await host.request('g.ready', { ready: true })).t, 'ok');
    peer.ws.close();
    await once(peer.ws, 'close');
    const peerState = m.players.get(peer.welcome.playerId);
    await host.find((f) => f.t === 'room.state' && f.inMatch && f.seats.some((p) => p?.playerId === peerState.playerId && !p.connected));
    assert.equal(peerState.connected, false);
    m.sched.advance((m.gd.prepTime(m.gd.bossRound) + 1) * 1000);
    assert.equal(m.phase, PHASE.PREP);
    const resumed = await client(t, server, 'Peer', peer.welcome.token);
    assert.equal(resumed.welcome.resumed, true);
    const restored = await resumed.find((f) => f.t === 'm.public' && f.phase === PHASE.PREP);
    assert.equal(restored.prepUnlimited, true);
    assert.equal(restored.deadline, 0);
    assert.equal((await resumed.request('room.leave')).t, 'ok');
    assert.equal(m.sched.runUntil(() => m.phase === PHASE.FINAL_ASSAULT, { maxTime: 10 }), true);
    assert.equal(m.errorCount, 0);

    const beforeFinish = host.frames.length;
    m.finish({ victory: false });
    assert.equal((await host.find((f) => f.t === 'room.state' && f.code === code && !f.inMatch
      && host.frames.indexOf(f) >= beforeFinish)).prepUnlimited, true);
    peer = resumed;
  }
});

test('endless clears vote over WebSocket, revive eliminated seats and reroll only the battlefield', { timeout: 20000 }, async (t) => {
  class ClockedMatch extends Match {
    constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: false }) }); }
  }
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false,
    MatchClass: ClockedMatch, versions: { enabled: ['act2autochess'] } });
  t.after(async () => {
    for (const socket of server.wss.clients || []) socket.terminate();
    await server.close();
  });
  const host = await client(t, server, 'Host');
  const other = await client(t, server, 'Other');
  const spectator = await client(t, server, 'Spectator');
  assert.equal((await host.request('room.create', { mode: 'solo', endless: true })).code, 'BAD_MSG');
  assert.equal((await host.request('room.create', { mode: 'coop', endless: true, prepUnlimited: true })).t, 'ok');
  const { code } = host.state();
  assert.equal(host.state().endless, true);
  assert.equal((await other.request('room.join', { code })).t, 'ok');
  assert.equal((await other.request('room.ready', { ready: true })).t, 'ok');
  assert.equal((await spectator.request('room.spectate', { code })).t, 'ok');
  assert.equal((await host.request('room.start')).t, 'ok');
  const m = server.lobby.rooms.get(code).match;
  const fallen = m.players.get(other.welcome.playerId);
  const stage = m.stageId;
  const opening = { factions: m.factions, pool: m.pool, itemPool: m.itemPool, bans: m.bannedChess, boss: m.bossId };
  const baseBossHp = bossPoolHp(m.gd, m.bossId, 2);
  const id = m.gd.visibleChess.find((c) => m.pool.left(c) > 0);
  const piece = fallen.acquireChess(id);
  assert.ok(piece);
  const inStock = m.pool.left(id);
  const bond = m.gd.bondIds[0];
  fallen.layers[bond] = 12;
  fallen.shop.level = 4;
  fallen.lp = 0;
  fallen.eliminate(3);
  assert.equal(m.pool.left(id), inStock);
  assert.ok(fallen.hand.includes(piece));
  assert.equal(fallen.alive, false);

  // Complete the normal boss flow using a deterministic victory. The field simulation is tested separately.
  const clear = () => {
    m.guard(() => {
      m.round = m.gd.bossRound;
      m.phase = PHASE.FINAL_ASSAULT;
      m.bossPool = { hp: 0, maxHp: 100, byPlayer: new Map() };
      m._finishFinal(false, () => { throw new Error('no fields in this fixture'); });
    });
    assert.equal(m.sched.runUntil(() => m.phase === PHASE.ENDLESS_VOTE, { maxTime: 5000 }), true);
    m.flush(true);
  };
  clear();
  const vote = await other.find((f) => f.t === 'm.public' && f.phase === PHASE.ENDLESS_VOTE);
  assert.deepEqual(vote.endless.vote.voters, [host.welcome.playerId, other.welcome.playerId]);
  assert.equal(vote.deadline - vote.serverNow, 30000);
  assert.equal(vote.endless.vote.nextMultiplier, 1.8);
  assert.equal((await spectator.request('g.endlessVote', { cycle: 1, agree: true })).code, 'SPECTATOR');
  assert.equal((await host.request('g.endlessVote', { cycle: 1, agree: true })).t, 'ok');
  other.ws.close();
  await once(other.ws, 'close');
  await host.find((f) => f.t === 'room.state' && f.inMatch && f.seats.some((s) => s?.playerId === fallen.playerId && !s.connected));
  assert.equal(m.phase, PHASE.ENDLESS_VOTE);
  const restored = await client(t, server, 'Other', other.welcome.token);
  const restoredVote = await restored.find((f) => f.t === 'm.public' && f.phase === PHASE.ENDLESS_VOTE);
  assert.deepEqual(restoredVote.endless.vote.agreed, [host.welcome.playerId]);
  assert.equal((await restored.request('g.endlessVote', { cycle: 1, agree: true })).t, 'ok');
  assert.equal(m.phase, PHASE.ROUND_START);
  assert.equal(m.round, 1);
  assert.equal(m.endlessCycle, 2);
  assert.notEqual(m.stageId, stage);
  assert.strictEqual(m.factions, opening.factions);
  assert.strictEqual(m.pool, opening.pool);
  assert.strictEqual(m.itemPool, opening.itemPool);
  assert.strictEqual(m.bannedChess, opening.bans);
  assert.equal(m.bossId, opening.boss);
  assert.equal(fallen.alive, true);
  assert.equal(fallen.eliminatedRound, null);
  assert.equal(fallen.lp, m.gd.startLp(fallen.bandId));
  assert.equal(fallen.shop.level, 4);
  assert.equal(fallen.layers[bond], 12);
  assert.ok(fallen.hand.includes(piece));
  assert.equal(m.pool.left(id), inStock);
  assert.equal(m.gd.enemyScale(1).hpMul, m.gd.baseEnemyScale(1).hpMul * 1.8);
  assert.equal(m.gd.enemyScale(1).atkMul, m.gd.baseEnemyScale(1).atkMul * 1.8);
  assert.equal(bossPoolHp(m.gd, m.bossId, 2), Math.round(baseBossHp * 1.8));
  assert.equal((await restored.request('g.endlessVote', { cycle: 1, agree: true })).code, 'WRONG_PHASE');
  assert.equal(host.frames.some((f) => f.t === 'm.result'), false);
  assert.equal(m.sched.runUntil(() => m.phase === PHASE.PREP, { maxTime: 5000 }), true);
  assert.equal(m.deadline, 0);

  clear();
  assert.equal((await restored.request('g.endlessVote', { cycle: 1, agree: true })).code, 'BAD_TARGET');
  m.sched.advance(30000);
  const result = await host.find((f) => f.t === 'm.result');
  assert.equal(result.victory, true);
  assert.deepEqual(result.endless, { cycle: 2, cleared: 2, multiplier: 1.8 });
  assert.equal(m.errorCount, 0);
});

test('endless bonus compounds to 20× and a defeat goes directly to settlement', () => {
  assert.deepEqual([1, 2, 3, 6, 7, 8, 30].map(endlessMultiplier), [1, 1.8, 3.24, 18.89568, 20, 20, 20]);
  assert.equal(validateC2S({ t: 'g.endlessVote', cycle: 0, agree: true }), 'bad field cycle');
  assert.deepEqual(wireOptions({ mode: 'coop', endless: true }), { mode: 'coop', endless: true });
  const m = new Match({ data: getData(), modeId: 'mode_multi_funny', mode: 'coop', difficulty: 'FUNNY', endless: true,
    seats: [{ seat: 0, playerId: 'p1', name: 'Host', connected: true }], send() {}, broadcast() {}, onEnd() {} });
  try {
    m.completeCycle({ victory: false, reason: 'defeat' });
    assert.equal(m.phase, PHASE.RESULT);
    assert.equal(m.lastResultMsg.endless.cleared, 0);
  } finally { m.dispose(); }
});

test('endless vote decline or hidden core handles vote cycle correctly', () => {
  const m = new Match({
    data: getData(), modeId: 'mode_multi_funny', mode: 'coop', difficulty: 'FUNNY', endless: true,
    seats: [
      { seat: 0, playerId: 'p1', name: 'P1', connected: true },
      { seat: 1, playerId: 'p2', name: 'P2', connected: true }
    ],
    send() {}, broadcast() {}, onEnd() {}
  });
  try {
    m.completeCycle({ victory: true, reason: 'victory' });
    assert.equal(m.phase, PHASE.ENDLESS_VOTE);
    const p1 = m.players.get('p1');
    const res = m.voteEndless(p1, 1, false);
    assert.equal(res.ok, true);
    assert.equal(m.phase, PHASE.RESULT);
    assert.equal(m.lastResultMsg.endless.cleared, 1);
  } finally { m.dispose(); }
});

function findBrowserExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

test('endless vote browser overlay displays above combat screen, handles clicks and confirms continuation', { timeout: 35000 }, async (t) => {
  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    t.skip('No Edge/Chrome browser executable found for browser regression test');
    return;
  }

  class ClockedMatch extends Match {
    constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: false }) }); }
  }
  const server = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false,
    MatchClass: ClockedMatch, versions: { enabled: ['act2autochess'] }
  });
  t.after(async () => {
    for (const socket of server.wss?.clients || []) socket.terminate();
    await server.close();
  });

  const host = await client(t, server, 'Host');
  assert.equal((await host.request('room.create', { mode: 'coop', endless: true, prepUnlimited: true })).t, 'ok');
  const { code } = host.state();

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // Pre-seed storage before navigation so client skips title screen directly
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('sp.name', 'BrowserPlayer');
    sessionStorage.setItem('sp.entered', '1');
  });
  await page.goto(`http://127.0.0.1:${server.port}/?room=${code}`);

  // Wait for BrowserPlayer to join the room and click ready
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some((b) => b.textContent.includes('准备'));
  }, { timeout: 8000 });

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find((b) => b.textContent.includes('准备'));
    if (btn) btn.click();
  });

  await host.request('room.ready', { ready: true });
  await host.request('room.start');

  const m = server.lobby.rooms.get(code).match;
  assert.ok(m, 'Match must be created');

  // Trigger boss victory to transition to ENDLESS_VOTE
  m.guard(() => {
    m.round = m.gd.bossRound;
    m.phase = PHASE.FINAL_ASSAULT;
    m.bossPool = { hp: 0, maxHp: 100, byPlayer: new Map() };
    m._finishFinal(false, () => { throw new Error('no fields in this fixture'); });
  });
  assert.equal(m.sched.runUntil(() => m.phase === PHASE.ENDLESS_VOTE, { maxTime: 5000 }), true);
  m.flush(true);

  // Wait for the browser to render the endless vote modal
  await page.waitForSelector('[data-testid="endless-vote"]', { timeout: 6000 });

  // Verify that the dialog is in viewport and hit test hits the button, NOT combat screen elements
  const voteCheck = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="endless-vote"]');
    const btns = Array.from(modal.querySelectorAll('button'));
    const agreeBtn = btns.find((b) => b.textContent.includes('继续下一轮'));
    if (!agreeBtn) return { ok: false, reason: 'agree button not found' };
    const rect = agreeBtn.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const isHitButton = hit === agreeBtn || agreeBtn.contains(hit);
    return {
      ok: isHitButton,
      btnText: agreeBtn.textContent.trim(),
      hitTag: hit ? hit.tagName : null,
      hitClass: hit ? hit.className : null
    };
  });

  assert.equal(voteCheck.ok, true, `Button must be clickable without occlusion, but hit ${voteCheck.hitTag}.${voteCheck.hitClass}`);

  // Test mobile landscape responsiveness: viewport height 380
  await page.setViewport({ width: 800, height: 380 });
  await delay(100);
  const landscapeCheck = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="endless-vote"]');
    const title = modal.querySelector('.modal__title');
    const btns = Array.from(modal.querySelectorAll('button'));
    const agreeBtn = btns.find((b) => b.textContent.includes('继续下一轮'));
    const declineBtn = btns.find((b) => b.textContent.includes('结束模拟'));
    const agreeRect = agreeBtn?.getBoundingClientRect();
    const declineRect = declineBtn?.getBoundingClientRect();
    return {
      titleVisible: !!title && title.getBoundingClientRect().height > 0,
      agreeInView: agreeRect && agreeRect.top >= 0 && agreeRect.bottom <= window.innerHeight,
      declineInView: declineRect && declineRect.top >= 0 && declineRect.bottom <= window.innerHeight
    };
  });
  assert.equal(landscapeCheck.titleVisible, true, 'Title must be visible in landscape');
  assert.equal(landscapeCheck.agreeInView, true, 'Agree button must be within viewport in landscape');
  assert.equal(landscapeCheck.declineInView, true, 'Decline button must be within viewport in landscape');

  // Reset viewport to desktop
  await page.setViewport({ width: 1280, height: 720 });
  await delay(100);

  // Click the agree button in browser
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="endless-vote"] button'));
    const agreeBtn = btns.find((b) => b.textContent.includes('继续下一轮'));
    if (agreeBtn) agreeBtn.click();
  });

  // Give match a flush to broadcast throttled m.public update in VirtualScheduler
  await delay(100);
  m.flush(true);

  // Wait for the button to show "已同意" and be disabled
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="endless-vote"] button'));
    const agreeBtn = btns.find((b) => b.textContent.includes('已同意'));
    return agreeBtn && agreeBtn.disabled;
  }, { timeout: 5000 });

  // Now host agrees as well
  const hostVoteRes = await host.request('g.endlessVote', { cycle: 1, agree: true });
  assert.equal(hostVoteRes.t, 'ok');
  m.flush(true);

  // Both agreed: match advances to ROUND_START cycle 2
  assert.equal(m.phase, PHASE.ROUND_START);
  assert.equal(m.endlessCycle, 2);

  // Endless vote modal should be unmounted
  await page.waitForFunction(() => !document.querySelector('[data-testid="endless-vote"]'), { timeout: 5000 });
});

