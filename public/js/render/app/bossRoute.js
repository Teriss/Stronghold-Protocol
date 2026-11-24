import {
  buildBossRoute, projectBossRoute, routeMarkLines, sampleBossRouteFrame,
  ROUTE_GLOW, ROUTE_LIGHT, ROUTE_OUTLINE, ROUTE_TONES,
} from '../bossRoute.js';

function line(g, points) {
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
}

function style(g, width, color, alpha) {
  g.lineStyle({ width, color, alpha, cap: 'round', join: 'round' });
}

function drawStaticFallback(g, { staticStrokes, staticArrows, width }) {
  g.clear();
  const w = Math.max(1.6, width * 0.72);
  style(g, w + 2, ROUTE_OUTLINE, 0.88);
  for (const { a, b } of staticStrokes) line(g, [a, b]);
  for (const [kind, tone] of Object.entries(ROUTE_TONES)) {
    style(g, w, tone.color, tone.alpha * 0.9);
    for (const e of staticStrokes) if (e.kind === kind) line(g, [e.a, e.b]);
  }
  for (const arrow of staticArrows) {
    style(g, 3.2, ROUTE_OUTLINE, 0.9);
    line(g, arrow.points);
    style(g, 1.5, ROUTE_LIGHT, ROUTE_TONES[arrow.kind].alpha);
    line(g, arrow.points);
  }
}

function drawRibbon(g, { width }, frame) {
  g.clear();
  // Soft crimson outer halo, tapering cleanly from tail to head.
  for (const s of frame.spans) {
    const t = (s.t0 + s.t1) / 2;
    const ease = t * t;
    if (ease < 0.01) continue;
    style(g, width * (1.2 + 1.45 * t), ROUTE_GLOW, 0.28 * ease);
    line(g, [s.a, s.b]);
  }
  // Dark crisp contrast underlay near the bright front half so the ribbon reads over light tiles.
  for (const s of frame.spans) {
    const t = (s.t0 + s.t1) / 2;
    if (t < 0.12) continue;
    style(g, width * (0.45 + 0.85 * t) + 1.8, ROUTE_OUTLINE, 0.72 * t * t);
    line(g, [s.a, s.b]);
  }
  // Main vivid Arknights red body.
  for (const s of frame.spans) {
    const t = (s.t0 + s.t1) / 2;
    const tone = ROUTE_TONES[s.kind] || ROUTE_TONES.patrol;
    style(g, width * (0.32 + 0.88 * t), tone.color, tone.alpha * Math.pow(t, 1.35));
    line(g, [s.a, s.b]);
  }
  // Hot pinkish-white core near the leading tip.
  for (const s of frame.spans) {
    const t = (s.t0 + s.t1) / 2;
    if (t < 0.45) continue;
    const hot = (t - 0.45) / 0.55;
    style(g, Math.max(1, width * 0.42 * hot), ROUTE_LIGHT, 0.85 * hot * hot);
    line(g, [s.a, s.b]);
  }
  // Trailing directional chevrons moving inside the ribbon.
  for (const ch of frame.chevrons) {
    style(g, 3.1, ROUTE_OUTLINE, 0.75 * ch.alpha);
    line(g, ch.points);
    style(g, 1.55, ROUTE_LIGHT, 0.92 * ch.alpha);
    line(g, ch.points);
  }
  // Crisp leading arrowhead + glowing tip dot.
  for (const head of frame.heads) {
    g.lineStyle(0);
    g.beginFill(ROUTE_GLOW, 0.38);
    g.drawCircle(head.x, head.y, head.radius * 1.9);
    g.endFill();
    style(g, 3.8, ROUTE_OUTLINE, 0.94);
    line(g, head.points);
    style(g, 2.1, ROUTE_LIGHT, 0.98);
    line(g, head.points);
    g.lineStyle(0);
    g.beginFill(ROUTE_LIGHT, 0.98);
    g.drawCircle(head.x, head.y, head.radius * 0.78);
    g.endFill();
  }
}

function drawMarks(g, { marks }, pulses) {
  g.clear();
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const pulse = pulses ? pulses[i] || 0 : 0;
    if (mark.kind === 'portal') {
      const lines = routeMarkLines(mark);
      style(g, 3.5, ROUTE_OUTLINE, 0.92);
      for (const pts of lines) line(g, pts);
      style(g, 1.7, ROUTE_LIGHT, 0.96);
      for (const pts of lines) line(g, pts);
      continue;
    }
    if (pulse > 0.02) {
      style(g, 2.2, ROUTE_GLOW, 0.65 * pulse);
      g.drawCircle(mark.x, mark.y, mark.radius + 2.5 + (1 - pulse) * 7.5);
    }
    g.lineStyle(0);
    g.beginFill(ROUTE_OUTLINE, 0.88);
    g.drawCircle(mark.x, mark.y, mark.radius);
    g.endFill();
    style(g, pulse > 0.2 ? 2.1 : 1.65, pulse > 0.2 ? ROUTE_LIGHT : ROUTE_TONES.patrol.color, 0.96);
    g.drawCircle(mark.x, mark.y, mark.radius);
    const extra = routeMarkLines(mark);
    if (extra.length) {
      style(g, 3.0, ROUTE_OUTLINE, 0.9);
      for (const pts of extra) line(g, pts);
      style(g, 1.45, ROUTE_LIGHT, 0.96);
      for (const pts of extra) line(g, pts);
    }
  }
}

export function createBossRouteLayer(P, layer, heightAt) {
  const staticSurface = new P.Graphics();
  const ribbon = new P.Graphics();
  const markRing = new P.Graphics();
  const labels = new P.Container();
  layer.eventMode = 'none';
  layer.visible = false;
  layer.addChild(staticSurface, ribbon, markRing, labels);

  const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let source = null, geometry = null, projected = null;
  let camera = null, cameraVersion = -1;
  let elapsed = 0;

  function clearLabels() {
    for (const child of labels.removeChildren()) child.destroy?.();
  }

  function buildLabels(proj) {
    clearLabels();
    for (const mark of proj.marks) {
      if (mark.order == null) continue;
      const fontSize = Math.max(10, Math.round(mark.radius * 1.28));
      const text = new P.Text(String(mark.order), {
        fontFamily: 'Bender, Oxanium, sans-serif',
        fontSize,
        fontWeight: '700',
        fill: '#ffece8',
        stroke: '#22090d',
        strokeThickness: 3,
      });
      text.anchor?.set?.(0.5);
      text.x = mark.x;
      text.y = mark.y + 0.5;
      labels.addChild(text);
    }
  }

  return {
    set(route) {
      if (route === source) return;
      source = route;
      geometry = buildBossRoute(route);
      projected = null;
      elapsed = 0;
      if (!geometry) {
        staticSurface.clear();
        ribbon.clear();
        markRing.clear();
        clearLabels();
      }
    },
    show(visible) { layer.visible = !!geometry && visible; },
    invalidate() { projected = null; },
    update(cam, dt) {
      if (!layer.visible || !geometry) return;
      if (!projected || camera !== cam || cameraVersion !== cam.version) {
        camera = cam;
        cameraVersion = cam.version;
        projected = projectBossRoute(geometry, ([r, c]) => cam.project(c, r, heightAt(Math.round(r), Math.round(c)) + 0.014));
        drawStaticFallback(staticSurface, projected);
        buildLabels(projected);
      }
      const reduced = motion?.matches === true;
      staticSurface.visible = reduced;
      ribbon.visible = !reduced;
      if (reduced) {
        drawMarks(markRing, projected, null);
        return;
      }
      elapsed += Math.max(0, Math.min(0.1, dt || 0));
      const frame = sampleBossRouteFrame(projected, elapsed);
      drawRibbon(ribbon, projected, frame);
      drawMarks(markRing, projected, frame.markPulses);
    },
    destroy() {
      clearLabels();
      staticSurface.clear();
      ribbon.clear();
      markRing.clear();
    },
    get summary() {
      return { visible: layer.visible, paths: geometry?.runs.length ?? 0, marks: geometry?.marks.length ?? 0 };
    },
  };
}
