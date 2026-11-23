import { ERR, PHASE } from '../../../shared/constants.js';
import { resetRoundCounters } from '../botEmotes.js';
import { pickBattleStage } from '../waves.js';
import { OK, fail } from './common.js';

const VOTE_SECONDS = 30;

export function endlessMultiplier(cycle) {
  return Number(Math.min(20, 1.8 ** (cycle - 1)).toFixed(6));
}

export class MatchEndless {
  completeCycle(outcome) {
    if (this.ended || this.disposed || this.endlessVote) return;
    if (!this.endless || !outcome.victory) { this.finish(outcome); return; }
    this.endlessCleared++;
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
