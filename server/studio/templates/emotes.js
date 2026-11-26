import fs from 'node:fs';
import { checkedPresentation } from './theme.js';
import { emotesOverlay } from '../../../public/studio/js/presentation.js';

const DEFAULT_SAMPLE_PATH = 'emotes/pack-1/slot-1.png';

export default {
  id: 'emotes', class: 'cosmetic', kinds: [], slots: () => [], overlay: () => ({}),
  build({ id, options }) {
    const o = checkedPresentation('emotes', id, null, options);
    const files = {};
    const usesSample = o.packs.some((p) => (p.slots || []).some((s) => s.image === DEFAULT_SAMPLE_PATH));
    if (usesSample) {
      files[DEFAULT_SAMPLE_PATH] = fs.readFileSync(new URL('../../../plugins/_template/cosmetic/media/sample.png', import.meta.url));
    }
    return {
      manifest: {
        scope: ['room'],
        permissions: ['assets.add'],
        assets: emotesOverlay(o.packs),
      },
      files,
    };
  },
};
