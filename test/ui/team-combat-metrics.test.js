import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serverCombatRecord, combineCombat } from '../../public/js/battle/metrics.js';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import { sortedPlayers } from '../../public/js/ui/gameLogic.js';
import { summarizeByPlayer } from '../../public/js/ui/combatMetrics.js';
import { validateC2S } from '../../shared/protocol.js';
import { makeMatch } from '../match/harness.js';
import { PHASE } from '../../shared/constants.js';

function makeMockNet() {
  const listeners = new Map();
  return {
    on(t, fn) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t).add(fn);
      return () => listeners.get(t)?.delete(fn);
    },
    emit(t, msg) { for (const fn of listeners.get(t) || []) fn(msg); },
    send() {},
    request() { return Promise.resolve(); },
  };
}

describe('serverCombatRecord and combineCombat', () => {
  test('converts server m.combatStats into per-player and ALL combat metrics', () => {
    const recA = serverCombatRecord({
      battleId: 'r1:n:p_0', round: 1, kind: 'normal', seconds: 10,
      players: { p_0: [{ uid: 1, defId: 'op_a', name: '能天使', kind: 'op', dmg: 1000, heal: 0 }] },
    });
    const recB = serverCombatRecord({
      battleId: 'r1:n:p_1', round: 1, kind: 'normal', seconds: 20,
      players: { p_1: [{ uid: 2, defId: 'op_b', name: '艾雅法拉', kind: 'op', dmg: 2000, heal: 200 }] },
    }, (_kind, defId) => (defId === 'op_b' ? { profession: 'CASTER', name: '艾雅法拉' } : null));

    const onlyA = combineCombat([recA, recB], 'p_0');
    assert.equal(onlyA.damage, 1000);
    assert.equal(onlyA.rows.length, 1);
    assert.equal(onlyA.rows[0].dps, 100);
    assert.equal(onlyA.rows[0].types.phys, 1000);

    const onlyB = combineCombat([recA, recB], 'p_1');
    assert.equal(onlyB.damage, 2000);
    assert.equal(onlyB.healing, 200);
    assert.equal(onlyB.rows[0].dps, 100);
    assert.equal(onlyB.rows[0].hps, 10);
    assert.equal(onlyB.rows[0].types.arts, 2000);

    const all = combineCombat([recA, recB], null);
    assert.equal(all.damage, 3000);
    assert.equal(all.healing, 200);
    assert.equal(all.rows.length, 2);
    assert.equal(all.rows[0].ownerId, 'p_1', 'sorted descending by damage');
    assert.equal(all.rows[1].ownerId, 'p_0');
  });
});

describe('runner m.combatStats ingestion', () => {
  test('ingests teammate m.combatStats and supports per-player and ALL across battle, last, and match scopes', () => {
    const net = makeMockNet();
    const store = createStore(initialState);
    const runner = createBattleRunner({ net, store, combatMetrics: true, doc: null });
    try {
      store.patch('match', { public: { phase: PHASE.COMBAT, round: 2 } });
      net.emit('m.combatStats', {
        t: 'm.combatStats', battleId: 'r2:n:p_0', round: 2, kind: 'normal', seconds: 10,
        players: { p_0: [{ uid: 1, defId: 'op_a', name: '能天使', kind: 'op', dmg: 500, heal: 0 }] },
      });
      net.emit('m.combatStats', {
        t: 'm.combatStats', battleId: 'r2:n:p_1', round: 2, kind: 'normal', seconds: 10,
        players: { p_1: [{ uid: 2, defId: 'op_b', name: '白面鸮', kind: 'op', dmg: 100, heal: 800 }] },
      });

      assert.equal(runner.combatMetrics({ scope: 'battle', ownerId: 'p_0' }).damage, 500);
      assert.equal(runner.combatMetrics({ scope: 'battle', ownerId: 'p_1' }).healing, 800);
      const battleAll = runner.combatMetrics({ scope: 'battle', ownerId: null });
      assert.equal(battleAll.damage, 600);
      assert.equal(battleAll.healing, 800);

      // Next round PREP: round 2 becomes 上一场战斗 for both individual players and ALL
      store.patch('match', { public: { phase: PHASE.PREP, round: 3 } });
      const lastAll = runner.combatMetrics({ scope: 'last', ownerId: null });
      assert.equal(lastAll.damage, 600);
      assert.equal(lastAll.healing, 800);
      assert.equal(runner.combatMetrics({ scope: 'last', ownerId: 'p_1' }).healing, 800);

      // Round 3 combat adds to 本局累计
      store.patch('match', { public: { phase: PHASE.COMBAT, round: 3 } });
      net.emit('m.combatStats', {
        t: 'm.combatStats', battleId: 'r3:n:p_0', round: 3, kind: 'normal', seconds: 10,
        players: { p_0: [{ uid: 1, defId: 'op_a', name: '能天使', kind: 'op', dmg: 700, heal: 0 }] },
      });
      assert.equal(runner.combatMetrics({ scope: 'match', ownerId: 'p_0' }).damage, 1200);
      assert.equal(runner.combatMetrics({ scope: 'match', ownerId: null }).damage, 1300);
    } finally {
      runner.dispose();
    }
  });
});

describe('server m.combatStats broadcast', () => {
  test('co-op match broadcasts m.combatStats after round 1 combat; solo match does not', () => {
    const coop = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 1, bots: 1, seed: 8101, captureFrames: true });
    coop.autoHumans();
    coop.m.start();
    coop.run(() => coop.ended != null || coop.m.round >= 2, { maxSteps: 5e5 });
    const coopFrames = coop.bc.filter((m) => m.t === 'm.combatStats');
    coop.m.dispose();
    assert.ok(coopFrames.length >= 2, 'co-op broadcasts m.combatStats for each field');
    assert.ok(coopFrames.some((f) => Object.hasOwn(f.players, 'p_0')));

    const solo = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 8102, captureFrames: true });
    solo.autoHumans();
    solo.m.start();
    solo.run(() => solo.ended != null || solo.m.round >= 2, { maxSteps: 5e5 });
    const soloFrames = solo.bc.filter((m) => m.t === 'm.combatStats');
    solo.m.dispose();
    assert.equal(soloFrames.length, 0, 'solo does not broadcast m.combatStats');
  });

  test('sortedPlayers accepts pub object including AI teammates in seat order', () => {
    const pub = { players: [{ playerId: 'ai_1', seat: 2, isBot: true }, { playerId: 'p_0', seat: 0, isBot: false }, { playerId: 'ai_0', seat: 1, isBot: true }] };
    assert.deepEqual(sortedPlayers(pub).map((p) => p.playerId), ['p_0', 'ai_0', 'ai_1']);
  });

  test('summarizeByPlayer aggregates operator rows into per-player totals sorted by damage', () => {
    const players = [
      { playerId: 'p_0', name: '凯尔希', seat: 0 },
      { playerId: 'p_1', name: 'AI·华法琳', seat: 1, isBot: true },
      { playerId: 'p_2', name: 'AI·阿米娅', seat: 2, isBot: true },
    ];
    const rows = [
      { ownerId: 'p_0', damage: 400, healing: 50, seconds: 10, types: { phys: 400, arts: 0, true: 0, elemental: 0 } },
      { ownerId: 'p_0', damage: 600, healing: 0, seconds: 10, types: { phys: 0, arts: 600, true: 0, elemental: 0 } },
      { ownerId: 'p_1', damage: 1500, healing: 300, seconds: 15, types: { phys: 1500, arts: 0, true: 0, elemental: 0 } },
    ];
    const out = summarizeByPlayer(rows, players);
    assert.equal(out.length, 3);
    assert.equal(out[0].ownerId, 'p_1');
    assert.equal(out[0].name, 'AI·华法琳');
    assert.equal(out[0].damage, 1500);
    assert.equal(out[0].dps, 100);
    assert.equal(out[0].hps, 20);
    assert.equal(out[1].ownerId, 'p_0');
    assert.equal(out[1].damage, 1000);
    assert.equal(out[1].types.phys, 400);
    assert.equal(out[1].types.arts, 600);
    assert.equal(out[2].ownerId, 'p_2');
    assert.equal(out[2].damage, 0);
  });

  test('b.progress validates optional live units payload and live m.combatStats does not overwrite 上一场战斗', () => {
    assert.equal(validateC2S({
      t: 'b.progress', battleId: 'b1', gt: 5, killed: 1, total: 5,
      units: { p_0: [{ uid: 1, defId: 'chess_1', name: '能天使', kind: 'op', dmg: 300, heal: 0 }] },
    }), null);

    const net = makeMockNet();
    const store = createStore(initialState);
    const runner = createBattleRunner({ net, store, combatMetrics: true, doc: null });
    try {
      store.patch('match', { public: { phase: PHASE.COMBAT, round: 1 } });
      net.emit('m.combatStats', {
        t: 'm.combatStats', battleId: 'r1:n:p_1', round: 1, kind: 'normal', seconds: 10,
        players: { p_1: [{ uid: 1, defId: 'op_a', name: '能天使', kind: 'op', dmg: 500, heal: 0 }] },
      });
      store.patch('match', { public: { phase: PHASE.COMBAT, round: 2 } });
      net.emit('m.combatStats', {
        t: 'm.combatStats', battleId: 'r2:n:p_1', round: 2, kind: 'normal', seconds: 4, live: true,
        players: { p_1: [{ uid: 1, defId: 'op_a', name: '能天使', kind: 'op', dmg: 200, heal: 0 }] },
      });
      assert.equal(runner.combatMetrics({ scope: 'battle', ownerId: 'p_1' }).damage, 200, 'live stats show in 当前战斗');
      assert.equal(runner.combatMetrics({ scope: 'last', ownerId: 'p_1' }).damage, 500, 'live stats do not replace 上一场战斗');
    } finally {
      runner.dispose();
    }
  });
});
