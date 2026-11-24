// PHASE.PREP double-click on a teammate avatar opens their field (GitHub #131, PR #374).
// 「前往查看」 stays. Two guards: a teammate with no field is not forced open, and a click while that
// teammate is already on screen does not open the view again (a double-click fires click first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { avatarRibbon, overviewBonds, overviewLineup, prepDblClickWatches, teammateClickWatches, teammateFieldShown } from '../../public/js/ui/teamPanel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/ui/teamPanel.js'), 'utf8');
const GAME_SRC = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
const GAME_CSS = readFileSync(path.join(ROOT, 'public/css/screens/game.css'), 'utf8');

const mate = { playerId: 'p_1', fieldId: 'f1', name: '队友' };
const observeOf = (fieldId) => ({ canObserve: () => (fieldId ? { fieldId } : { reason: '该队友当前没有战场' }) });

test('a prep double-click watches once when the teammate has a field and is not already on screen', () => {
  const o = { phase: PHASE.PREP, self: false, observe: observeOf('n:p_1'), watching: null, player: mate };
  assert.equal(prepDblClickWatches(o), true);
  assert.equal(prepDblClickWatches({ ...o, watching: 'n:p_1' }), false, 'already the prep scout');
  assert.equal(prepDblClickWatches({ ...o, watching: 'f1' }), false, 'already their live field');
  assert.equal(prepDblClickWatches({ ...o, askedRecently: true }), false, 'the click of this double-click already opened it');
});

test('no field: the double-click does not watch; the single click still toasts through onWatch', () => {
  const o = { phase: PHASE.PREP, self: false, observe: observeOf(null), watching: null, player: mate };
  assert.equal(prepDblClickWatches(o), false);
  assert.equal(prepDblClickWatches({ ...o, observe: { canObserve: () => null } }), false);
  assert.equal(prepDblClickWatches({ ...o, observe: {} }), false);
});

test('outside PREP, on your own row, or without client-combat observe, a double-click does not watch', () => {
  const base = { phase: PHASE.PREP, self: false, observe: observeOf('n:p_1'), watching: null, player: mate };
  assert.equal(prepDblClickWatches({ ...base, phase: PHASE.COMBAT }), false);
  assert.equal(prepDblClickWatches({ ...base, phase: PHASE.FINAL_ASSAULT }), false, '最终攻势 prep is not PHASE.PREP');
  assert.equal(prepDblClickWatches({ ...base, phase: PHASE.HIDDEN_CORE }), false, '隐秘核心 prep is not PHASE.PREP');
  assert.equal(prepDblClickWatches({ ...base, self: true }), false);
  assert.equal(prepDblClickWatches({ ...base, observe: null }), false, 'the click already watches in server-run combat');
  assert.equal(prepDblClickWatches({ ...base, player: null }), false);
});

test('a single click while already watching that teammate does not open the view again', () => {
  assert.equal(teammateClickWatches({ watching: null, player: mate }), true, 'server-run combat: the first click watches');
  assert.equal(teammateClickWatches({ watching: 'f1', player: mate }), false);
  assert.equal(teammateClickWatches({ watching: 'n:p_1', player: mate }), false);
  assert.equal(teammateClickWatches({ watching: 'other', player: mate }), true);
  assert.equal(teammateClickWatches({ watching: null, player: mate, askedRecently: true }), false, 'the other click of a double-click');
  assert.equal(teammateClickWatches({ observe: observeOf('n:p_1'), watching: null, player: mate }), false, 'client combat opens 「前往查看」, it does not watch on click');
  assert.equal(teammateFieldShown('n:p_1', mate), true);
  assert.equal(teammateFieldShown(null, mate), false);
});

test('the panel wires both guards and keeps 「前往观战」 and 「返回战场」', () => {
  assert.ok(SRC.includes('onDblClick=${(e) => dblClick(e, p, self)}'));
  assert.ok(SRC.includes('prepDblClickWatches('));
  assert.ok(SRC.includes('teammateClickWatches('));
  assert.ok(SRC.includes("${t('前往观战')}"));
  assert.ok(SRC.includes("${t('返回战场')}"));
});

test('overview helpers sort active bonds (noStack last), resolve lineups and choose avatar ribbons', () => {
  const bonds = overviewBonds({
    bonds: [
      { bondId: 'b_low', active: true, layers: 12 },
      { bondId: 'b_off', active: true, off: true, layers: 99 },
      { bondId: 'b_nostack', active: true, layers: 500 },
      { bondId: 'b_hi', active: true, layers: 136 },
      { bondId: 'b_idle', active: false, layers: 40 },
    ],
  }, {
    bondRec: (id) => (id === 'b_nostack' ? { noStack: true } : {}),
  });
  assert.deepEqual(bonds.map((b) => [b.bondId, b.hideLayers]), [
    ['b_hi', false],
    ['b_low', false],
    ['b_nostack', true],
  ]);

  const selfLineup = overviewLineup({ lineup: [] }, {
    self: true,
    priv: {
      board: [
        { uid: 1, kind: 'chess', id: 'chess_char_1_02_a', golden: true, tier: 4, items: [{ id: 'item_a' }] },
        { uid: 2, kind: 'token', id: 'tok_1' },
      ],
    },
  });
  assert.equal(selfLineup.length, 1);
  assert.deepEqual([selfLineup[0].id, selfLineup[0].golden, selfLineup[0].items], ['chess_char_1_02_a', true, ['item_a']]);

  assert.equal(avatarRibbon(mate, { self: false, observe: observeOf('n:p_1'), watched: false }), 'watch');
  assert.equal(avatarRibbon(mate, { self: false, observe: observeOf('n:p_1'), watched: true }), 'watching');
  assert.equal(avatarRibbon(mate, { self: false, observe: observeOf(null), watched: false }), null);
  assert.equal(avatarRibbon({ playerId: 'p_0' }, { self: true, observe: { ...observeOf('n:p_1'), observing: false } }), null);
  assert.equal(avatarRibbon({ playerId: 'p_0' }, { self: true, observe: { ...observeOf('n:p_1'), observing: true } }), 'back');
});

test('overview removes legacy TeamOverview modal, wires clickable units and stacks popups above overview', () => {
  assert.equal(existsSync(path.join(ROOT, 'public/js/ui/teamOverview.js')), false, 'legacy teamOverview.js removed');
  assert.equal(GAME_SRC.includes('teamOverview.js'), false, 'game.js no longer imports legacy TeamOverview');
  assert.equal(GAME_SRC.includes('<${TeamOverview}'), false, 'game.js no longer renders legacy TeamOverview');

  assert.ok(SRC.includes('class="team-ov__unit"'), 'overview unit portraits are clickable buttons');
  assert.ok(SRC.includes('onOverviewChange'), 'TeamPanel notifies open state for layering');
  assert.ok(GAME_SRC.includes("teamOverviewOpen && 'has-team-overview'"), 'game root flags open team overview');
  assert.ok(GAME_SRC.includes('onChess=${(u, p) =>'), 'game wires overview operator clicks to DetailPanel');
  assert.ok(GAME_SRC.includes('.team-ov__bond'), 'outside-click guard preserves BondPopup clicked from overview');
  assert.ok(GAME_SRC.includes('.team-ov__unit'), 'outside-click guard preserves DetailPanel clicked from overview');

  assert.ok(GAME_CSS.includes('.gm.has-team-overview .dpanel'), 'DetailPanel rises above open overview');
  assert.ok(GAME_CSS.includes('.gm.has-team-overview .bpop'), 'BondPopup rises above open overview');
  assert.ok(SRC.includes('class="team-ov__name-row"') && SRC.includes('class="team-ov__meta-row"'),
    'overview separates name+status and level/LP/miss metadata into two rows');
});
