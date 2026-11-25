import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S } from '../shared/protocol.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';

function makeSession(reg, name) {
  const s = reg.create(name);
  const frames = [];
  s.connected = true;
  s.ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(raw) { frames.push(JSON.parse(raw)); },
  };
  return { session: s, frames };
}

class FakeMatch {
  constructor(opts) {
    this.opts = opts;
    this.round = 3;
    this.spectators = new Set(opts.spectators || []);
  }
  start() {}
  dispose() {}
  onLeave() {}
  addSpectator(id) { this.spectators.add(id); }
  removeSpectator(id) { this.spectators.delete(id); }
}

describe('protocol validation for room.list, room.setPrepUnlimited, room.setEndless', () => {
  test('validates C2S frames strictly', () => {
    assert.equal(validateC2S({ t: 'room.list' }), null);
    assert.equal(validateC2S({ t: 'room.setPrepUnlimited', on: true }), null);
    assert.equal(validateC2S({ t: 'room.setPrepUnlimited', on: false }), null);
    assert.notEqual(validateC2S({ t: 'room.setPrepUnlimited', on: 'true' }), null);
    assert.notEqual(validateC2S({ t: 'room.setPrepUnlimited' }), null);
    assert.equal(validateC2S({ t: 'room.setEndless', on: true }), null);
    assert.equal(validateC2S({ t: 'room.setEndless', on: false }), null);
    assert.notEqual(validateC2S({ t: 'room.setEndless', on: 1 }), null);
    assert.notEqual(validateC2S({ t: 'room.setEndless' }), null);
    assert.equal(validateC2S({ t: 'room.setCapacity', capacity: 4 }), null);
    assert.equal(validateC2S({ t: 'room.setCapacity', capacity: 6 }), null);
    assert.equal(validateC2S({ t: 'room.setCapacity', capacity: 8 }), null);
    assert.notEqual(validateC2S({ t: 'room.setCapacity', capacity: 5 }), null);
    assert.notEqual(validateC2S({ t: 'room.setCapacity' }), null);
  });
});

describe('lobby room.list and spectator dissolution', () => {
  test('lists only active co-op rooms with status, seats, spectators, rules, and dissolves when all players leave (excluding spectators)', () => {
    let clock = 1000;
    const reg = new SessionRegistry({ now: () => clock });
    const lobby = new Lobby({ registry: reg, MatchClass: FakeMatch, now: () => clock });

    const host1 = makeSession(reg, '凯尔希');
    const host2 = makeSession(reg, '阿米娅');
    const soloHost = makeSession(reg, '陈');
    const spec = makeSession(reg, '能天使');
    const browser = makeSession(reg, '德克萨斯');

    // Solo room should not appear in room.list
    assert.deepEqual(lobby.handleMessage(soloHost.session, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' }), { ok: true });

    // Co-op room 1: waiting with 1 human + 1 bot + 1 spectator, prepUnlimited & endless on
    clock = 2000;
    assert.deepEqual(lobby.handleMessage(host1.session, { t: 'room.create', mode: 'coop', difficulty: 'HARD' }), { ok: true });
    const code1 = host1.session.roomCode;
    assert.deepEqual(lobby.handleMessage(host1.session, { t: 'room.addBot' }), { ok: true });
    assert.deepEqual(lobby.handleMessage(host1.session, { t: 'room.setPrepUnlimited', on: true }), { ok: true });
    assert.deepEqual(lobby.handleMessage(host1.session, { t: 'room.setEndless', on: true }), { ok: true });
    assert.deepEqual(lobby.handleMessage(spec.session, { t: 'room.spectate', code: code1 }), { ok: true });

    // Co-op room 2: in match
    clock = 3000;
    assert.deepEqual(lobby.handleMessage(host2.session, { t: 'room.create', mode: 'coop', difficulty: 'ABYSS' }), { ok: true });
    const code2 = host2.session.roomCode;
    assert.deepEqual(lobby.handleMessage(host2.session, { t: 'room.start' }), { ok: true });

    // Query room.list
    browser.frames.length = 0;
    assert.deepEqual(lobby.handleMessage(browser.session, { t: 'room.list' }), { ok: true });
    const listFrame = browser.frames.find((f) => f.t === 'room.list');
    assert.ok(listFrame);
    assert.equal(listFrame.rooms.length, 2);

    // Waiting room with free seats sorts before in-match room
    assert.equal(listFrame.rooms[0].code, code1);
    assert.equal(listFrame.rooms[0].hostName, '凯尔希');
    assert.equal(listFrame.rooms[0].difficulty, 'HARD');
    assert.equal(listFrame.rooms[0].humans, 1);
    assert.equal(listFrame.rooms[0].bots, 1);
    assert.equal(listFrame.rooms[0].occupied, 2);
    assert.equal(listFrame.rooms[0].freeSeats, 2);
    assert.equal(listFrame.rooms[0].spectators, 1);
    assert.equal(listFrame.rooms[0].inMatch, false);
    assert.equal(listFrame.rooms[0].prepUnlimited, true);
    assert.equal(listFrame.rooms[0].endless, true);

    assert.equal(listFrame.rooms[1].code, code2);
    assert.equal(listFrame.rooms[1].inMatch, true);
    assert.equal(listFrame.rooms[1].round, 3);

    // When the only human player in room 1 leaves, the room dissolves even though a spectator is still there
    spec.frames.length = 0;
    assert.deepEqual(lobby.handleMessage(host1.session, { t: 'room.leave' }), { ok: true });
    assert.equal(lobby.getRoom(code1), null, 'room disposed when last human left');
    assert.equal(spec.session.roomCode, null, 'spectator detached from dissolved room');
    assert.ok(spec.frames.some((f) => f.t === 'room.closed' && f.reason === 'empty'), 'spectator told room.closed empty');

    // room.list no longer contains room 1
    browser.frames.length = 0;
    assert.deepEqual(lobby.handleMessage(browser.session, { t: 'room.list' }), { ok: true });
    const afterFrame = browser.frames.find((f) => f.t === 'room.list');
    assert.deepEqual(afterFrame.rooms.map((r) => r.code), [code2]);
  });
});

describe('lobby room.setPrepUnlimited and room.setEndless', () => {
  test('host toggles prepUnlimited and endless before match; un-readies guests; refused for non-host, spectator, solo, and in-match', () => {
    const reg = new SessionRegistry();
    const matches = [];
    class SpyMatch extends FakeMatch {
      constructor(opts) { super(opts); matches.push(opts); }
    }
    const lobby = new Lobby({ registry: reg, MatchClass: SpyMatch });

    const host = makeSession(reg, '凯尔希');
    const guest = makeSession(reg, '阿米娅');
    const spec = makeSession(reg, '能天使');
    const solo = makeSession(reg, '陈');

    // Solo room rejects both
    lobby.handleMessage(solo.session, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    assert.equal(lobby.handleMessage(solo.session, { t: 'room.setPrepUnlimited', on: true }).error, 'BAD_TARGET');
    assert.equal(lobby.handleMessage(solo.session, { t: 'room.setEndless', on: true }).error, 'BAD_TARGET');

    // Co-op room
    lobby.handleMessage(host.session, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    const code = host.session.roomCode;
    lobby.handleMessage(guest.session, { t: 'room.join', code });
    lobby.handleMessage(spec.session, { t: 'room.spectate', code });

    // Non-host and spectator refused
    assert.equal(lobby.handleMessage(guest.session, { t: 'room.setPrepUnlimited', on: true }).error, 'NOT_HOST');
    assert.equal(lobby.handleMessage(guest.session, { t: 'room.setEndless', on: true }).error, 'NOT_HOST');
    assert.equal(lobby.handleMessage(spec.session, { t: 'room.setPrepUnlimited', on: true }).error, 'SPECTATOR');
    assert.equal(lobby.handleMessage(spec.session, { t: 'room.setEndless', on: true }).error, 'SPECTATOR');

    // Guest readies; host enables prepUnlimited -> un-readies guest
    lobby.handleMessage(guest.session, { t: 'room.ready', ready: true });
    assert.equal(lobby.getRoom(code).seatOf(guest.session.playerId).ready, true);
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.setPrepUnlimited', on: true }), { ok: true });
    assert.equal(lobby.getRoom(code).prepUnlimited, true);
    assert.equal(lobby.getRoom(code).seatOf(guest.session.playerId).ready, false);

    // Guest readies again; host enables endless -> un-readies guest
    lobby.handleMessage(guest.session, { t: 'room.ready', ready: true });
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.setEndless', on: true }), { ok: true });
    assert.equal(lobby.getRoom(code).endless, true);
    assert.equal(lobby.getRoom(code).seatOf(guest.session.playerId).ready, false);

    // Start match: Match receives both options
    lobby.handleMessage(guest.session, { t: 'room.ready', ready: true });
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.start' }), { ok: true });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].prepUnlimited, true);
    assert.equal(matches[0].endless, true);

    // Cannot change while in match
    assert.equal(lobby.handleMessage(host.session, { t: 'room.setPrepUnlimited', on: false }).error, 'ROOM_STARTED');
    assert.equal(lobby.handleMessage(host.session, { t: 'room.setEndless', on: false }).error, 'ROOM_STARTED');
  });
});

describe('lobby room.setCapacity', () => {
  test('host expands and shrinks capacity with seat compaction; refuses shrinking below occupied count or non-host/solo/in-match', () => {
    const reg = new SessionRegistry();
    const lobby = new Lobby({ registry: reg, MatchClass: FakeMatch });
    const host = makeSession(reg, '凯尔希');
    const guest = makeSession(reg, '阿米娅');
    const spec = makeSession(reg, '能天使');
    const solo = makeSession(reg, '陈');

    lobby.handleMessage(solo.session, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    assert.equal(lobby.handleMessage(solo.session, { t: 'room.setCapacity', capacity: 6 }).error, 'BAD_TARGET');

    lobby.handleMessage(host.session, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    const code = host.session.roomCode;
    lobby.handleMessage(guest.session, { t: 'room.join', code });
    lobby.handleMessage(spec.session, { t: 'room.spectate', code });

    assert.equal(lobby.handleMessage(guest.session, { t: 'room.setCapacity', capacity: 6 }).error, 'NOT_HOST');
    assert.equal(lobby.handleMessage(spec.session, { t: 'room.setCapacity', capacity: 6 }).error, 'SPECTATOR');

    // Expand 4 -> 8 un-readies guest
    lobby.handleMessage(guest.session, { t: 'room.ready', ready: true });
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.setCapacity', capacity: 8 }), { ok: true });
    assert.equal(lobby.getRoom(code).capacity, 8);
    assert.equal(lobby.getRoom(code).seats.length, 8);
    assert.equal(lobby.getRoom(code).seatOf(guest.session.playerId).ready, false);

    // Fill 3 bots (total 5 occupied: seats 0..4) -> shrinking to 4 is refused, shrinking to 6 succeeds
    lobby.handleMessage(host.session, { t: 'room.addBot' });
    lobby.handleMessage(host.session, { t: 'room.addBot' });
    lobby.handleMessage(host.session, { t: 'room.addBot' });
    assert.equal(lobby.handleMessage(host.session, { t: 'room.setCapacity', capacity: 4 }).error, 'BAD_TARGET');
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.setCapacity', capacity: 6 }), { ok: true });
    assert.equal(lobby.getRoom(code).capacity, 6);

    // Remove seat 2 (bot) so seat 4 is occupied while seat 2 is free -> shrinking 6 -> 4 compacts seat 4 into seat 2
    lobby.handleMessage(host.session, { t: 'room.removeBot', seat: 2 });
    const seat4Bot = lobby.getRoom(code).seats[4];
    assert.ok(seat4Bot);
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.setCapacity', capacity: 4 }), { ok: true });
    assert.equal(lobby.getRoom(code).capacity, 4);
    assert.equal(lobby.getRoom(code).seats.length, 4);
    assert.equal(lobby.getRoom(code).seats[2], seat4Bot);
    assert.equal(seat4Bot.seat, 2);

    // Refused once match starts
    lobby.handleMessage(guest.session, { t: 'room.ready', ready: true });
    assert.deepEqual(lobby.handleMessage(host.session, { t: 'room.start' }), { ok: true });
    assert.equal(lobby.handleMessage(host.session, { t: 'room.setCapacity', capacity: 6 }).error, 'ROOM_STARTED');
  });
});

describe('room screen helpers for prepUnlimitedOption, endlessOption, and capacityOption', () => {
  test('returns null for solo, editable for host before match, read-only for guest/spectator/inMatch', async () => {
    const { prepUnlimitedOption, endlessOption, capacityOption } = await import('../public/js/screens/room.js');
    assert.equal(prepUnlimitedOption({ mode: 'solo', hostId: 'h' }, 'h'), null);
    assert.equal(endlessOption({ mode: 'solo', hostId: 'h' }, 'h'), null);
    assert.equal(capacityOption({ mode: 'solo', hostId: 'h' }, 'h'), null);
    assert.deepEqual(prepUnlimitedOption({ mode: 'coop', hostId: 'h', prepUnlimited: true, inMatch: false }, 'h'), { on: true, editable: true });
    assert.deepEqual(prepUnlimitedOption({ mode: 'coop', hostId: 'h', prepUnlimited: true, inMatch: false }, 'g'), { on: true, editable: false });
    assert.deepEqual(prepUnlimitedOption({ mode: 'coop', hostId: 'h', prepUnlimited: false, inMatch: true }, 'h'), { on: false, editable: false });
    assert.deepEqual(endlessOption({ mode: 'coop', hostId: 'h', endless: true, inMatch: false }, 'h'), { on: true, editable: true });
    assert.deepEqual(endlessOption({ mode: 'coop', hostId: 'h', endless: false, inMatch: false }, 'g'), { on: false, editable: false });
    assert.deepEqual(capacityOption({ mode: 'coop', hostId: 'h', capacity: 6, inMatch: false, seats: [{ playerId: 'h' }, { playerId: 'g' }, null, null, null, null] }, 'h'), { value: 6, occupied: 2, editable: true });
    assert.deepEqual(capacityOption({ mode: 'coop', hostId: 'h', capacity: 6, inMatch: false, seats: [{ playerId: 'h' }] }, 'g'), { value: 6, occupied: 1, editable: false });
  });
});
