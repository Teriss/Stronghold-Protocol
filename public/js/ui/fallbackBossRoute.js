import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import {
  projectBossRoute, routeMarkLines, sampleBossRouteFrame,
  ROUTE_GLOW, ROUTE_LIGHT, ROUTE_OUTLINE, ROUTE_TONES,
} from '../render/bossRoute.js';

const color = (n) => `#${n.toString(16).padStart(6, '0')}`;
const path = (points) => points.map(({ x, y }, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

export function FallbackBossRoute({ geometry, project, width, height }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setElapsed(0);
    const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let last = 0;
    const tick = (now) => {
      raf = 0;
      if (mq?.matches) return;
      if (last > 0) {
        const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
        setElapsed((prev) => prev + dt);
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (mq?.matches || raf) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const onChange = () => {
      if (mq?.matches) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
      } else {
        start();
      }
    };
    start();
    mq?.addEventListener?.('change', onChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      mq?.removeEventListener?.('change', onChange);
    };
  }, [geometry]);

  const ink = projectBossRoute(geometry, project);
  const frame = sampleBossRouteFrame(ink, elapsed);
  const accent = color(ROUTE_LIGHT);
  const outline = color(ROUTE_OUTLINE);
  const glow = color(ROUTE_GLOW);
  const staticWidth = Math.max(1.6, ink.width * 0.72);

  return html`<svg class="ff-boss-route" aria-hidden="true" viewBox=${`0 0 ${width} ${height}`} width=${width} height=${height}
       fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g class="ff-boss-route__static">
      <path d=${ink.staticStrokes.map(({ a, b }) => path([a, b])).join('')} stroke=${outline} stroke-opacity=".88" stroke-width=${staticWidth + 2} />
      ${Object.entries(ROUTE_TONES).map(([kind, tone]) => html`<path key=${kind} stroke=${color(tone.color)} stroke-opacity=${tone.alpha * 0.9} stroke-width=${staticWidth}
        d=${ink.staticStrokes.filter((e) => e.kind === kind).map(({ a, b }) => path([a, b])).join('')} />`)}
      ${ink.staticArrows.map(({ points, kind }, i) => html`<g key=${i}>
        <path d=${path(points)} stroke=${outline} stroke-width="3.2" />
        <path d=${path(points)} stroke=${accent} stroke-opacity=${ROUTE_TONES[kind].alpha} stroke-width="1.5" />
      </g>`)}
    </g>
    <g class="ff-boss-route__flow">
      ${frame.spans.map((s, i) => {
        const t = (s.t0 + s.t1) / 2;
        const ease = t * t;
        const tone = ROUTE_TONES[s.kind] || ROUTE_TONES.patrol;
        const d = path([s.a, s.b]);
        const hot = t > 0.45 ? (t - 0.45) / 0.55 : 0;
        return html`<g key=${i}>
          ${ease >= 0.01 ? html`<path d=${d} stroke=${glow} stroke-opacity=${(0.28 * ease).toFixed(3)} stroke-width=${(ink.width * (1.2 + 1.45 * t)).toFixed(2)} />` : null}
          ${t >= 0.12 ? html`<path d=${d} stroke=${outline} stroke-opacity=${(0.72 * ease).toFixed(3)} stroke-width=${(ink.width * (0.45 + 0.85 * t) + 1.8).toFixed(2)} />` : null}
          <path d=${d} stroke=${color(tone.color)} stroke-opacity=${(tone.alpha * Math.pow(t, 1.35)).toFixed(3)} stroke-width=${(ink.width * (0.32 + 0.88 * t)).toFixed(2)} />
          ${hot > 0 ? html`<path d=${d} stroke=${accent} stroke-opacity=${(0.85 * hot * hot).toFixed(3)} stroke-width=${Math.max(1, ink.width * 0.42 * hot).toFixed(2)} />` : null}
        </g>`;
      })}
      ${frame.chevrons.map(({ points, alpha }, i) => html`<g key=${`c${i}`}>
        <path d=${path(points)} stroke=${outline} stroke-opacity=${(0.75 * alpha).toFixed(3)} stroke-width="3.1" />
        <path d=${path(points)} stroke=${accent} stroke-opacity=${(0.92 * alpha).toFixed(3)} stroke-width="1.55" />
      </g>`)}
      ${frame.heads.map((head, i) => html`<g key=${`h${i}`}>
        <circle cx=${head.x.toFixed(1)} cy=${head.y.toFixed(1)} r=${(head.radius * 1.9).toFixed(1)} fill=${glow} fill-opacity=".38" />
        <path d=${path(head.points)} stroke=${outline} stroke-width="3.8" />
        <path d=${path(head.points)} stroke=${accent} stroke-width="2.1" />
        <circle cx=${head.x.toFixed(1)} cy=${head.y.toFixed(1)} r=${(head.radius * 0.78).toFixed(1)} fill=${accent} />
      </g>`)}
    </g>
    ${ink.marks.map((mark, i) => {
      const pulse = frame.markPulses[i] || 0;
      const lines = routeMarkLines(mark);
      if (mark.kind === 'portal') {
        return html`<g key=${i} class="ff-boss-route__portal">
          ${lines.map((pts, j) => html`<g key=${j}>
            <path d=${path(pts)} stroke=${outline} stroke-width="3.5" />
            <path d=${path(pts)} stroke=${accent} stroke-width="1.7" />
          </g>`)}
        </g>`;
      }
      const fontSize = Math.max(9, Math.round(mark.radius * 1.24));
      return html`<g key=${i} class=${`ff-boss-route__${mark.kind}`}>
        ${pulse > 0.02 ? html`<circle class="ff-boss-route__pulse" cx=${mark.x.toFixed(1)} cy=${mark.y.toFixed(1)}
          r=${(mark.radius + 2.5 + (1 - pulse) * 7.5).toFixed(1)} stroke=${glow} stroke-opacity=${(0.65 * pulse).toFixed(3)} stroke-width="2.2" />` : null}
        <circle cx=${mark.x.toFixed(1)} cy=${mark.y.toFixed(1)} r=${mark.radius.toFixed(1)}
          fill=${outline} fill-opacity=".88" stroke=${pulse > 0.2 ? accent : color(ROUTE_TONES.patrol.color)} stroke-width=${pulse > 0.2 ? '2.1' : '1.65'} />
        ${lines.map((pts, j) => html`<g key=${j}>
          <path d=${path(pts)} stroke=${outline} stroke-width="3" />
          <path d=${path(pts)} stroke=${accent} stroke-width="1.45" />
        </g>`)}
        ${mark.order != null ? html`<text x=${mark.x.toFixed(1)} y=${(mark.y + 0.5).toFixed(1)} text-anchor="middle" dominant-baseline="central"
          fill="#ffece8" font-family="Bender, Oxanium, sans-serif" font-size=${fontSize} font-weight="700">${mark.order}</text>` : null}
      </g>`;
    })}
  </svg>`;
}
