// No wall clock in the sim: the page converts elapsed presentation time to whole fixed ticks.
import { SPEEDS } from '../../../shared/studio/scenario.js';

export function makeRunner(battle, { cap = 240, onFrame = () => {}, preview = false } = {}) {
  let playing = false, speed = 1, remainder = 0, ticks = 0, touched = false, quiet = false;
  const capture = () => onFrame(battle.snapshot(), battle.drainEvents());
  const stepTicks = (n) => {
    for (let i = 0; i < n && !battle.finished; i++) {
      battle.step(); ticks++;
      if (ticks >= Math.ceil(cap * 30) && !battle.finished) battle.forceEnd('timeout');
      if (!quiet) capture();
    }
    if (battle.finished) playing = false;
  };
  battle.start();
  // [ASSUMED] A paused preview steps past DEPLOY_ANIM_TIME (0.5s = 15 ticks at 30 Hz,
  // server/sim/constants.js) so placed operators are shown idle. The opening deploy beam is
  // dropped; spawn infos stay, or the view builds a red placeholder (render/app.js createUnknown)
  // for every operator, summon and crate that was already on the field. Enemies may move during
  // that half second. The default (preview false) stays at t = 0 until the user steps or plays.
  if (preview) {
    quiet = true;
    stepTicks(15);
    quiet = false;
    const ev = battle.drainEvents().filter((e) => e[0] !== 'deploy');
    onFrame(battle.snapshot(), ev);
  } else capture();
  return {
    battle,
    get playing() { return playing; }, get speed() { return speed; }, get touched() { return touched; },
    play() { touched = true; if (!battle.finished) playing = true; },
    pause() { playing = false; remainder = 0; },
    speedTo(value) { if (!SPEEDS.includes(value)) throw new RangeError('speed'); speed = value; },
    step(n = 1) { if (n !== 1 && n !== 30) throw new RangeError('ticks'); touched = true; playing = false; remainder = 0; stepTicks(n); },
    advance(seconds) {
      if (!playing || !Number.isFinite(seconds) || seconds <= 0) return;
      remainder += Math.min(seconds, 0.2) * speed * 30;
      const n = Math.floor(remainder + 1e-9); remainder -= n; stepTicks(n);
    },
  };
}
