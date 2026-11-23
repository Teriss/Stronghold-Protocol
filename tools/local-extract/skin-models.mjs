// The same Spine parser/role resolver as the v0.4.0 base asset builder; batch stdin avoids spawning per outfit.
import fs from 'node:fs';
import { parseSkel } from '../assets/skel.mjs';
import { resolveRoles } from '../assets/anim-roles.mjs';

const jobs = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = jobs.map(file => {
  try {
    const sk = parseSkel(fs.readFileSync(file));
    if (!sk.animations.length) throw new Error('skeleton has no readable animations');
    return { pma: true,
      anims: resolveRoles(sk.animations, { skillIndices: [0, 1, 2], durations: sk.durations }),
      animations: sk.durations, events: sk.events, hits: sk.hits, bounds: sk.bounds };
  } catch (err) {
    return { error: err.message };
  }
});
process.stdout.write(JSON.stringify(results));
