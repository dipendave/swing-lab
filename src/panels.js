// The two explanatory drawings in the readout panel: the boundary-layer
// picture seen from above, and side force against speed. Both are SVG.

const NS = 'http://www.w3.org/2000/svg';
const INK = '#12301f', INK2 = '#44594c', INK3 = '#6d7d72', RULE = '#cfd6c8';
const LAM = '#2466d6', TURB = '#d9650a', CHERRY = '#9c1a2c';
const D2R = Math.PI / 180;

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
}
const f1 = (x) => x.toFixed(1);

function leather(wear) {
  const w = Math.min(1, Math.max(0, wear / 100));
  const mix = (a, b) => Math.round(a + (b - a) * w);
  return `rgb(${mix(160, 122)}, ${mix(24, 80)}, ${mix(36, 70)})`;
}

// -------------------------------------------------------------- flow diagram
export class FlowDiagram {
  constructor(host) {
    this.svg = el('svg', { viewBox: '0 0 300 232', role: 'img' });
    host.appendChild(this.svg);
  }

  /**
   * snap: result of flowSnapshot(). ball: { wearOff, wearLeg }.
   * forceShare: side force as a fraction of the ball's weight (signed, + off side).
   */
  draw(snap, ball, forceShare) {
    const svg = this.svg;
    svg.replaceChildren();
    const cx = 150, cy = 112, R = 44;
    const title = el('title', {}, 'Top view of the ball and the air layer on each side');
    svg.appendChild(title);

    // horizontal frame: fh points at the batter (up the page), lh to the off side (left)
    const f = snap.flight;
    const fl = Math.hypot(f[0], f[1]) || 1;
    const fh = [f[0] / fl, f[1] / fl, 0];
    const lh = [-fh[1], fh[0], 0];
    const sx = (p) => cx - (p[0] * lh[0] + p[1] * lh[1]) * R;
    const sy = (p) => cy - (p[0] * fh[0] + p[1] * fh[1]) * R;
    const onRim = (deg, side, r = R) => [cx - side * r * Math.sin(deg * D2R), cy - r * Math.cos(deg * D2R)];

    // wake: the dead air behind the two separation points, pushed off-centre
    const L = snap.left, Rt = snap.right;
    const pl = onRim(L.sep, 1), pr = onRim(Rt.sep, -1);
    const shift = Math.max(-60, Math.min(60, snap.cs * 150));
    const bottom = 226;
    let wake = `M${f1(pl[0])},${f1(pl[1])} `;
    for (let a = L.sep; a <= 180; a += 4) { const p = onRim(a, 1); wake += `L${f1(p[0])},${f1(p[1])} `; }
    for (let a = 180; a >= Rt.sep; a -= 4) { const p = onRim(a, -1); wake += `L${f1(p[0])},${f1(p[1])} `; }
    wake += `L${f1(pr[0])},${f1(pr[1])} `;
    wake += `Q${f1(pr[0] + shift * 0.25)},${f1((pr[1] + bottom) / 2)} ${f1(pr[0] + shift + 6)},${bottom} `;
    wake += `L${f1(pl[0] + shift - 6)},${bottom} `;
    wake += `Q${f1(pl[0] + shift * 0.25)},${f1((pl[1] + bottom) / 2)} ${f1(pl[0])},${f1(pl[1])}Z`;
    const defs = el('defs');
    const grad = el('linearGradient', { id: 'wakefade', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(el('stop', { offset: '0', 'stop-color': '#aab6ae', 'stop-opacity': '0.55' }), el('stop', { offset: '1', 'stop-color': '#aab6ae', 'stop-opacity': '0.05' }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(el('path', { d: wake, fill: 'url(#wakefade)' }));

    // the ball, its two halves shaded by wear
    const n = snap.seamNormal;
    const nh = Math.hypot(n[0], n[1]);
    const topIsA = n[2] > 0;
    svg.appendChild(el('circle', { cx, cy, r: R, fill: leather(nh < 0.05 ? (topIsA ? ball.wearOff : ball.wearLeg) : ball.wearLeg) }));
    let e1 = null, e2 = null;
    if (nh >= 0.05) {
      e1 = [-n[1] / nh, n[0] / nh, 0];
      e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
      if (e2[2] < 0) e2 = e2.map((v) => -v);
      const nH = [n[0] / nh, n[1] / nh, 0];
      let d = '';
      for (let k = 0; k <= 36; k++) {
        const a = (k / 36) * Math.PI;
        const p = [Math.cos(a) * e1[0] + Math.sin(a) * e2[0], Math.cos(a) * e1[1] + Math.sin(a) * e2[1]];
        d += `${k ? 'L' : 'M'}${f1(sx(p))},${f1(sy(p))} `;
      }
      for (let k = 1; k <= 36; k++) {
        const a = (k / 36) * Math.PI;
        const p = [-Math.cos(a) * e1[0] + Math.sin(a) * nH[0], -Math.cos(a) * e1[1] + Math.sin(a) * nH[1]];
        d += `L${f1(sx(p))},${f1(sy(p))} `;
      }
      svg.appendChild(el('path', { d: d + 'Z', fill: leather(ball.wearOff) }));
      // the seam as seen from above
      let s = '';
      for (let k = 0; k <= 36; k++) {
        const a = (k / 36) * Math.PI;
        const p = [Math.cos(a) * e1[0] + Math.sin(a) * e2[0], Math.cos(a) * e1[1] + Math.sin(a) * e2[1]];
        s += `${k ? 'L' : 'M'}${f1(sx(p))},${f1(sy(p))} `;
      }
      svg.appendChild(el('path', { d: s, fill: 'none', stroke: '#f3ead2', 'stroke-width': 7, 'stroke-linecap': 'butt', opacity: 0.95 }));
      svg.appendChild(el('path', { d: s, fill: 'none', stroke: '#7a1020', 'stroke-width': 1.2, 'stroke-dasharray': '2.5 2.5' }));
    }
    svg.appendChild(el('circle', { cx, cy, r: R, fill: 'none', stroke: INK, 'stroke-width': 1 }));

    // boundary layers
    const arc = (side, from, to, r) => {
      let d = '';
      const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 3));
      for (let k = 0; k <= steps; k++) {
        const p = onRim(from + ((to - from) * k) / steps, side, r);
        d += `${k ? 'L' : 'M'}${f1(p[0])},${f1(p[1])} `;
      }
      return d;
    };
    const layer = (side, info) => {
      const r = R + 7;
      const turb = info.turb;
      if (turb < 0.98) {
        svg.appendChild(el('path', { d: arc(side, 3, 82, r), fill: 'none', stroke: LAM, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 1 - turb * 0.85 }));
      }
      if (turb > 0.02 && Number.isFinite(info.trans)) {
        const end = turb > 0.98 ? info.sep : Math.max(info.sep, 95);
        svg.appendChild(el('path', { d: arc(side, 3, Math.max(3, info.trans - 2), r), fill: 'none', stroke: LAM, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: turb }));
        svg.appendChild(el('path', { d: arc(side, info.trans + 2, end, r), fill: 'none', stroke: TURB, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.25 + 0.75 * turb }));
      }
      // where the layer lets go
      const a = onRim(info.sep, side, R + 1), b = onRim(info.sep, side, R + 16);
      svg.appendChild(el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: INK, 'stroke-width': 1.5 }));
      const c = onRim(info.sep, side, R + 25);
      svg.appendChild(el('text', { x: c[0], y: c[1] + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: INK }, `${Math.round(info.sep)}°`));
    };
    layer(1, L);
    layer(-1, Rt);

    // oncoming air
    for (const x of [cx - 26, cx, cx + 26]) {
      svg.appendChild(el('line', { x1: x, y1: 8, x2: x, y2: 26, stroke: INK3, 'stroke-width': 1 }));
      svg.appendChild(el('path', { d: `M${x - 3},21 L${x},27 L${x + 3},21`, fill: 'none', stroke: INK3, 'stroke-width': 1 }));
    }

    // side force, drawn above the equator so it clears the separation marks
    const ay = cy - 26;
    if (Math.abs(snap.cs) > 0.008) {
      const dir = snap.cs > 0 ? -1 : 1;
      const len = Math.min(64, 16 + Math.abs(snap.cs) * 160);
      const x0 = cx + dir * (R + 12), x1 = x0 + dir * len;
      svg.appendChild(el('line', { x1: x0, y1: ay, x2: x1 - dir * 2, y2: ay, stroke: INK, 'stroke-width': 3 }));
      svg.appendChild(el('path', { d: `M${x1},${ay} L${x1 - dir * 9},${ay - 5.5} L${x1 - dir * 9},${ay + 5.5}Z`, fill: INK }));
    }

    const state = (info) => (info.turb > 0.85 ? 'turbulent' : info.turb < 0.15 ? 'laminar' : 'part turbulent');
    const side = (x, anchor, name, info) => {
      svg.appendChild(el('text', { x, y: 16, 'text-anchor': anchor, 'font-size': 12, 'font-weight': 700, fill: INK }, name));
      svg.appendChild(el('text', { x, y: 30, 'text-anchor': anchor, 'font-size': 11.5, fill: INK2 }, state(info)));
    };
    side(8, 'start', 'Off side', L);
    side(292, 'end', 'Leg side', Rt);
    if (Math.abs(forceShare) >= 0.005) {
      const toOff = forceShare > 0;
      svg.appendChild(el('text', { x: toOff ? 8 : 292, y: ay - 12, 'text-anchor': toOff ? 'start' : 'end', 'font-size': 11.5, fill: INK2 },
        `Pushed with ${Math.round(Math.abs(forceShare) * 100)}%`));
      svg.appendChild(el('text', { x: toOff ? 8 : 292, y: ay + 20, 'text-anchor': toOff ? 'start' : 'end', 'font-size': 11.5, fill: INK2 }, 'of its weight'));
    }
  }
}

// --------------------------------------------------------------- swing curve
export class SwingCurve {
  constructor(host) {
    this.host = host;
    this.W = 300; this.H = 190;
    this.m = { l: 30, r: 12, t: 22, b: 26 };
    this.svg = el('svg', { viewBox: `0 0 ${this.W} ${this.H}`, role: 'img', tabindex: 0, 'aria-label': 'Side force coefficient against speed' });
    host.appendChild(this.svg);
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    host.appendChild(this.tip);
    this.data = [];
    this.hoverIdx = -1;
    this.svg.addEventListener('pointermove', (e) => this._hover(e));
    this.svg.addEventListener('pointerleave', () => this._setHover(-1));
    this.svg.addEventListener('blur', () => this._setHover(-1));
    this.svg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const start = this.hoverIdx < 0 ? this._nearest(this.release) : this.hoverIdx;
      this._setHover(Math.max(0, Math.min(this.data.length - 1, start + (e.key === 'ArrowRight' ? 1 : -1))));
    });
  }

  x(kmh) { return this.m.l + ((kmh - this.x0) / (this.x1 - this.x0)) * (this.W - this.m.l - this.m.r); }
  y(c) { return this.m.t + ((this.yMax - c) / (2 * this.yMax)) * (this.H - this.m.t - this.m.b); }
  _nearest(kmh) {
    let best = 0;
    for (let i = 1; i < this.data.length; i++) if (Math.abs(this.data[i].kmh - kmh) < Math.abs(this.data[best].kmh - kmh)) best = i;
    return best;
  }

  /** data: [{kmh, cs}]. release: release speed. describe(point) -> string for the tooltip. */
  draw(data, release, describe) {
    this.data = data;
    this.release = release;
    this.describe = describe;
    this.x0 = data[0].kmh; this.x1 = data[data.length - 1].kmh;
    const peak = Math.max(...data.map((d) => Math.abs(d.cs)));
    this.yMax = Math.max(0.4, Math.ceil(peak * 10 + 0.5) / 10);
    const svg = this.svg;
    svg.replaceChildren();
    const { l, r, t, b } = this.m;
    const right = this.W - r, bot = this.H - b;

    for (let c = -this.yMax; c <= this.yMax + 1e-9; c += 0.2) {
      const zero = Math.abs(c) < 1e-9;
      svg.appendChild(el('line', { x1: l, x2: right, y1: this.y(c), y2: this.y(c), stroke: zero ? INK3 : RULE, 'stroke-width': 1 }));
      svg.appendChild(el('text', { x: l - 5, y: this.y(c) + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: INK3 }, zero ? '0' : Math.abs(c).toFixed(1)));
    }
    for (let v = 60; v <= this.x1; v += 20) {
      const lastTick = v + 20 > this.x1;
      svg.appendChild(el('text', { x: lastTick ? right + 8 : this.x(v), y: bot + 15, 'text-anchor': lastTick ? 'end' : 'middle', 'font-size': 10.5, fill: INK3 }, lastTick ? `${v} km/h` : String(v)));
    }
    svg.appendChild(el('text', { x: l + 4, y: t + 9, 'font-size': 10.5, fill: INK2 }, 'toward off side'));
    svg.appendChild(el('text', { x: l + 4, y: bot - 5, 'font-size': 10.5, fill: INK2 }, 'toward leg side'));

    let d = '';
    data.forEach((p, i) => { d += `${i ? 'L' : 'M'}${f1(this.x(p.kmh))},${f1(this.y(p.cs))} `; });
    svg.appendChild(el('path', { d, fill: 'none', stroke: INK, 'stroke-width': 2, 'stroke-linejoin': 'round' }));

    // release speed
    const ri = this._nearest(release);
    const rx = this.x(release);
    svg.appendChild(el('line', { x1: rx, x2: rx, y1: t - 4, y2: bot, stroke: CHERRY, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
    const anchor = rx > this.W - 70 ? 'end' : rx < 70 ? 'start' : 'middle';
    svg.appendChild(el('text', { x: rx, y: t - 8, 'text-anchor': anchor, 'font-size': 11, 'font-weight': 700, fill: INK }, `Release ${Math.round(release)}`));
    this.nowDot = el('circle', { r: 4.5, fill: '#fff', stroke: CHERRY, 'stroke-width': 2, cx: rx, cy: this.y(data[ri].cs) });
    svg.appendChild(el('circle', { r: 5, fill: CHERRY, stroke: '#fff', 'stroke-width': 2, cx: rx, cy: this.y(data[ri].cs) }));
    svg.appendChild(this.nowDot);

    this.cross = el('line', { y1: t, y2: bot, stroke: INK, 'stroke-width': 1, visibility: 'hidden' });
    this.crossDot = el('circle', { r: 4, fill: INK, stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' });
    svg.append(this.cross, this.crossDot);
    this._setHover(-1);
  }

  /** Move the open marker to the ball's current speed and side force. */
  setNow(kmh, cs) {
    if (!this.nowDot) return;
    const k = Math.max(this.x0, Math.min(this.x1, kmh));
    this.nowDot.setAttribute('cx', this.x(k));
    this.nowDot.setAttribute('cy', this.y(Math.max(-this.yMax, Math.min(this.yMax, cs))));
  }

  _hover(e) {
    const box = this.svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * this.W;
    const kmh = this.x0 + ((px - this.m.l) / (this.W - this.m.l - this.m.r)) * (this.x1 - this.x0);
    this._setHover(this._nearest(kmh));
  }

  _setHover(i) {
    this.hoverIdx = i;
    if (i < 0 || !this.data[i]) {
      if (this.cross) { this.cross.setAttribute('visibility', 'hidden'); this.crossDot.setAttribute('visibility', 'hidden'); }
      this.tip.hidden = true;
      return;
    }
    const p = this.data[i];
    const x = this.x(p.kmh), y = this.y(p.cs);
    this.cross.setAttribute('x1', x); this.cross.setAttribute('x2', x); this.cross.setAttribute('visibility', 'visible');
    this.crossDot.setAttribute('cx', x); this.crossDot.setAttribute('cy', y); this.crossDot.setAttribute('visibility', 'visible');
    this.tip.replaceChildren();
    const b = document.createElement('b');
    b.textContent = `${Math.abs(p.cs).toFixed(2)}`;
    this.tip.append(b, document.createTextNode(` at ${Math.round(p.kmh)} km/h`), document.createElement('br'), document.createTextNode(this.describe(p)));
    this.tip.hidden = false;
    const frac = x / this.W;
    this.tip.style.left = frac > 0.55 ? 'auto' : `calc(${frac * 100}% + 10px)`;
    this.tip.style.right = frac > 0.55 ? `calc(${(1 - frac) * 100}% + 10px)` : 'auto';
  }
}
