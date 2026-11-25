// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO, ERR } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS, OK, fail } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onStartUnite } from '../botEmotes.js';

export class MatchUnite {
  startUnite(plan) {
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const battle = this.newBattle(this._uniteOpts(plan, limit));
    this.fields = [{ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, plan); // an AI helper says "合作愉快" once on the open of a 联防 (enabled by default; SP_BOT_EMOTES=0 silences it)
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const res = runner.resultOf(this.fields[0]);
        this._collectSimErrors(this.fields[0], res);
        this._broadcastCombatStats(this.fields[0], res);
        this.fields[0].live = false;
        this.deadline = 0;
        this.markPublic();
        this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, res));
      },
    });
    this.runner.start();
  }

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, `u:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId: 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const f = this._ccField({ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts: this._uniteOpts(plan, limit) });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, 'u');
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const res = f.result;
    this._collectSimErrors(f, res);
    this._broadcastCombatStats(f, res);
    this._stopClientCombat();
    f.live = false;
    this.deadline = 0;
    this.markPublic();
    const plan = this.unitePlan;
    this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, res));
  }

  /**
   * 联防阶段个人投降 (`g.surrender` from a helper; rules: docs/design/match.md §联防阶段投降). The helper's side leaves
   * the shared field for good (Battle.surrenderPlayer: every operator dies, nothing revives or redeploys, its summons go
   * with it) while the teammate keeps fighting — no LP is charged here, the field's own billing does it (unite.js
   * uniteSurvivors: an enemy still standing at the end costs the player that leaked it). When the LAST helper stands
   * down the field has nobody left to defend it: it ends as its timeout, so every enemy still owed (on the field or
   * never spawned) is charged to its source and the round settles through the ordinary 联防 settlement.
   *
   * Client-side combat: the surrender travels to every viewer as `b.surrender` (at the field clock it happened) so their
   * replica drops that side too; the field record keeps it (`f.surrenders`) for a resync b.start and for a server
   * takeover, which replays it at the same game time (fields.js HeadlessJob events).
   */
  _surrenderUnite(ps) {
    const plan = this.unitePlan;
    if (!plan || !plan.helpers.includes(ps)) return fail(ERR.WRONG_PHASE, 'not a unite helper');
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    if (!f || f.done || f.verifyJob || !f.live) return fail(ERR.WRONG_PHASE);
    if (!f.surrendered) f.surrendered = new Set();
    const pid = ps.playerId;
    if (f.surrendered.has(pid)) return OK;
    f.surrendered.add(pid);
    if (!f.surrenders) f.surrenders = [];
    const last = plan.helpers.every((p) => f.surrendered.has(p.playerId));
    if (f.cc) {
      const at = f.mode === 'server' && f.battle ? Number(f.battle.time) || 0 : this._fieldElapsed(f);
      f.surrenders.push({ playerId: pid, at });
      if (f.mode === 'server') {
        // the server is already simulating this field: apply it to the running battle, and end it if it was the last one
        if (f.battle && !f.battle.finished) f.battle.surrenderPlayer(pid);
        if (last && f.battle && !f.battle.finished) f.battle.forceEnd('timeout');
      } else {
        for (const viewer of this.watchersOf(f.fieldId)) {
          this.sendTo(viewer, { t: 'b.surrender', battleId: f.battleId, fieldId: f.fieldId, playerId: pid, at });
        }
        // nobody is left on the field: replay to the field clock, apply the surrenders and end it as its timeout
        if (last) this._surrenderClientField(f, 'timeout');
      }
    } else {
      const at = Number(f.battle && f.battle.time) || 0;
      f.surrenders.push({ playerId: pid, at });
      if (f.battle && !f.battle.finished) f.battle.surrenderPlayer(pid);
      if (last) this.runner.forceField(f, 'timeout');
    }
    this.markPublic();
    return OK;
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down; a split or a summon raises nothing (a 联防 field tags its runtime spawns
   * `uniteRuntime`, spawns.js — they never crossed the leaker's own goal, so they are neither billed nor shown here).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what the escaped wave sent that leaker (fields.js uniteBillBounds:
   * keySourceCounts only — the same set settlement bills); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        // the sample is [gt, killed, total, resolved(, left)]: a 联防 sample's `left` is its 5th element
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
