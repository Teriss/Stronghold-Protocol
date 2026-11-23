import { ERR, PHASE } from '../../../shared/constants.js';
import { resetRoundCounters } from '../botEmotes.js';
import { baseWaveEnemies, pickBattleStage, reinforceNormalWave } from '../waves.js';
import { OK, fail } from './common.js';

const VOTE_SECONDS = 30;

export function endlessMultiplier(cycle) {
  return Number(Math.min(20, 1.8 ** (cycle - 1)).toFixed(6));
}

export class MatchEndless {
  scaleEndlessWave(wave, round) {
    const last = this.gd.bossRound - 1;
    if (this.endlessCycle === 1) {
      if (round >= last - 2) {
        const count = baseWaveEnemies(this.gd, wave).reduce((n, s) => n + s.count, 0);
        this.endlessTailCount = Math.max(this.endlessTailCount, count);
      }
      return wave;
    }
    // [ASSUMED] Add 15% of the first cycle's tail wave over each full cycle, up to twice that wave.
    const progress = (round - 1) / Math.max(1, last - 1);
    const growth = Math.min(2, 1 + 0.15 * (this.endlessCycle - 2 + progress));
    return reinforceNormalWave(this.gd, wave, Math.min(100, Math.ceil(this.endlessTailCount * growth)));
  }

  completeCycle(outcome) {
    if (this.ended || this.disposed || this.endlessVote) return;
    if (!this.endless || !outcome.victory) {
      this.finish({ ...outcome, endlessCombatDefeat: this.endless && !outcome.victory });
      return;
    }
    this.endlessCleared++;
    const clear = { roundsPassed: this.gd.bossRound + (outcome.hiddenCleared ? 1 : 0),
      hiddenReached: this.hiddenReached, hiddenCleared: !!outcome.hiddenCleared };
    if (!this.endlessBestClear || clear.roundsPassed >= this.endlessBestClear.roundsPassed) {
      this.endlessBestClear = { ...clear, hiddenReached: clear.hiddenReached || !!this.endlessBestClear?.hiddenReached };
    }
    for (const ps of this.alivePlayers()) {
      if (ps.left) continue;
      const prior = this.endlessPlayerClears.get(ps.playerId);
      if (!prior || clear.roundsPassed >= prior.roundsPassed) {
        this.endlessPlayerClears.set(ps.playerId, { ...clear, hiddenReached: clear.hiddenReached || !!prior?.hiddenReached });
      }
    }
    this.phase = PHASE.ENDLESS_VOTE;
    this.endlessVote = { outcome, agreed: new Set() };
    this.setDeadline(VOTE_SECONDS, () => this.closeEndlessVote(false));
    this.markPublic();
    this.resolveEndlessVote();
  }

  endlessVoters() {
    return this.order.filter((p) => !p.isBot && !p.left).map((p) => p.playerId);
  }

  voteEndless(ps, cycle, agree) {
    if (!this.endlessVote || this.phase !== PHASE.ENDLESS_VOTE) return fail(ERR.WRONG_PHASE);
    if (cycle !== this.endlessCycle) return fail(ERR.BAD_TARGET);
    if (ps.isBot || ps.left || !ps.connected) return fail(ERR.BAD_TARGET);
    if (!agree) { this.closeEndlessVote(false); return OK; }
    this.endlessVote.agreed.add(ps.playerId);
    this.markPublic();
    this.resolveEndlessVote();
    return OK;
  }

  resolveEndlessVote() {
    if (!this.endlessVote) return;
    const voters = this.endlessVoters();
    if (!voters.length) { this.closeEndlessVote(false); return; }
    if (voters.every((id) => this.endlessVote.agreed.has(id))) this.closeEndlessVote(true);
  }

  closeEndlessVote(continuing) {
    const vote = this.endlessVote;
    if (!vote) return;
    this.endlessVote = null;
    this.setDeadline(0);
    if (!continuing) { this.finish(vote.outcome); return; }
    this.endlessCycle++;
    this.gd.previousEndlessEnemyMultiplier = this.gd.endlessEnemyMultiplier;
    this.gd.endlessEnemyMultiplier = endlessMultiplier(this.endlessCycle);
    this.stageId = pickBattleStage(this.gd, this.rngSetup, this.stageId);
    this.stage = this.gd.stage(this.stageId);
    this.teamLp = null;
    this.bossPool = null;
    this.bossPairs = null;
    this.hiddenReached = false;
    this.hiddenLayerSum = 0;
    this.lastResults.clear();
    this._botPath = null;
    this._botPathBody = null;
    for (const ps of this.order) {
      if (ps.left) continue;
      if (!ps.alive) {
        ps.alive = true;
        ps.lp = this.gd.startLp(ps.bandId);
        ps.eliminatedRound = null;
      } else {
        // The pooled boss HP distribution can round a survivor's individual share down to zero.
        ps.lp = Math.max(1, ps.lp);
      }
      ps.lpAtFinal = null;
      ps.invalidateDeployMap();
      ps.dirty();
    }
    resetRoundCounters(this);
    this.startRound(1);
  }
}
