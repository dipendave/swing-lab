// Where the fielders stand, and where the ball goes after it reaches the
// batter. Pure logic: positions and paths in pitch axes (x toward the batter's
// end, y toward the off side, z up, metres).
import { BALL, PITCH } from './physics.js';

const S = PITCH.length;
const G = 9.80665;

/** Fielders for a right-handed batter. Two fields: catchers in, or boundary riders out. */
export const FIELDS = {
  slips: {
    keeper: { at: [S + 11.5, 0.3], label: 'the keeper' },
    slip1: { at: [S + 12.2, 1.7], label: 'first slip' },
    slip2: { at: [S + 11.8, 2.9], label: 'second slip' },
    gully: { at: [S + 7.5, 7.5], label: 'gully' },
    point: { at: [S - 1.5, 25], label: 'point' },
    cover: { at: [S - 13, 23], label: 'cover' },
    midOff: { at: [-4, 13], label: 'mid-off' },
    midOn: { at: [-4, -13], label: 'mid-on' },
    midwicket: { at: [S - 10, -24], label: 'midwicket' },
    fineLeg: { at: [S + 38, -30], label: 'fine leg' },
  },
  spread: {
    keeper: { at: [S + 11.5, 0.3], label: 'the keeper' },
    thirdMan: { at: [S + 40, 28], label: 'third man' },
    point: { at: [S - 1.5, 26], label: 'point' },
    cover: { at: [S - 13, 23], label: 'cover' },
    deepCover: { at: [S - 28, 50], label: 'deep cover' },
    longOff: { at: [-34, 20], label: 'long-off' },
    longOn: { at: [-34, -20], label: 'long-on' },
    deepMidwicket: { at: [S - 24, -52], label: 'deep midwicket' },
    deepSquare: { at: [S + 2, -58], label: 'deep square' },
    fineLeg: { at: [S + 38, -30], label: 'fine leg' },
  },
};

// who takes a catch off each kind of mistake, per field
const CATCHERS = {
  slips: { behind: 'keeper', slip: 'slip2', drive: 'midOff', cut: 'point', pull: 'midwicket', flick: 'midwicket', hook: 'fineLeg', slog: 'midOn', top: 'fineLeg' },
  spread: { behind: 'keeper', slip: 'keeper', drive: 'longOff', cut: 'point', pull: 'deepSquare', flick: 'deepSquare', hook: 'fineLeg', slog: 'longOn', top: 'fineLeg' },
};

/** The fielder who catches a given kind of chance: { id, label, at }. */
export function catcher(field, kind) {
  const f = FIELDS[field] ? field : 'slips';
  const id = CATCHERS[f][kind] || 'keeper';
  return { id, ...FIELDS[f][id] };
}

// direction of a stroke, as an angle from straight back past the bowler,
// positive toward the off side (degrees), and how far it can vary
const STROKES = {
  defend: [0, 25], push: [5, 50], dig: [0, 30], drive: [22, 32], cut: [92, 16],
  glance: [-122, 18], flick: [-68, 18], pull: [-85, 22], hook: [-132, 14], slog: [-45, 22],
};
// pace off the bat and loft, by runs scored
const PACE = { 0: [7, 4], 1: [14, 6], 2: [20, 8], 3: [22, 8], 4: [31, 4], 6: [35, 33] };

function sample(t, p, v, q) {
  return { t, p: p.slice(), v: v.slice(), q, speed: Math.hypot(v[0], v[1], v[2]), cs: 0, cd: 0, after: true };
}

// free flight with a little drag, then skidding along the turf
function roll(start, v0, q, tMax, out) {
  const dt = 0.01;
  const p = start.p.slice();
  const v = v0.slice();
  let t = start.t;
  let grounded = false;
  for (let i = 0; i < tMax / dt; i++) {
    const sp = Math.hypot(v[0], v[1], v[2]);
    const k = 0.006 * sp; // air drag
    v[0] -= k * v[0] * dt; v[1] -= k * v[1] * dt;
    if (grounded) {
      const h = Math.hypot(v[0], v[1]);
      if (h < 0.4) break;
      const dec = Math.min(h, 3.2 * dt);
      v[0] -= (v[0] / h) * dec; v[1] -= (v[1] / h) * dec;
      v[2] = 0; p[2] = BALL.radius;
    } else {
      v[2] -= (G + k * v[2]) * dt;
    }
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
    if (!grounded && p[2] <= BALL.radius) {
      p[2] = BALL.radius;
      if (Math.abs(v[2]) < 1.2) grounded = true;
      else { v[2] = -v[2] * 0.4; v[0] *= 0.85; v[1] *= 0.85; }
    }
    t += dt;
    out.push(sample(t, p, v, q));
  }
  return t;
}

// a throw-like arc that arrives at `to` after `T` seconds
function arcTo(start, to, T, q, out) {
  const d = [to[0] - start.p[0], to[1] - start.p[1], to[2] - start.p[2]];
  const v = [d[0] / T, d[1] / T, (d[2] + 0.5 * G * T * T) / T];
  const n = Math.max(2, Math.ceil(T / 0.01));
  for (let i = 1; i <= n; i++) {
    const s = (T * i) / n;
    out.push(sample(start.t + s, [start.p[0] + v[0] * s, start.p[1] + v[1] * s, start.p[2] + v[2] * s - 0.5 * G * s * s], [v[0], v[1], v[2] - G * s], q));
  }
  return start.t + T;
}

/**
 * The whole flight to show for one delivery: the simulated ball up to the
 * batter, then whatever the outcome sends it to do.
 *   sim      result of simulate()
 *   outcome  result of faceBall()
 *   field    'slips' | 'spread'
 *   rng      () => number in [0, 1)
 * Returns { samples, contactTime, stumpsTime, caughtBy, endTime }.
 * stumpsTime is when the stumps are broken, or null.
 */
export function flightAfter(sim, outcome, field, rng) {
  const main = sim.main.samples;
  const res = outcome.result;
  const c = outcome.contact;
  const q = c.q || main[0].q;
  const speedIn = Math.hypot(c.v[0], c.v[1], c.v[2]);
  const done = (samples, extra = {}) => ({
    samples, contactTime: c.t, stumpsTime: null, caughtBy: null,
    endTime: samples[samples.length - 1].t, ...extra,
  });
  const spread = (centre, width) => centre + (rng() * 2 - 1) * width;

  // ---- nothing in the way: the ball as simulated, then on to the keeper
  const untouched = outcome.quality === 'none' || outcome.quality === 'miss';
  const hitPad = res.how === 'lbw' || res.how === 'pad';
  if (untouched && !hitPad) {
    if (res.wicket === 'bowled' && sim.main.hitStumps) {
      return done(main.slice(), { stumpsTime: main[main.length - 1].t });
    }
    const keep = [];
    for (const s of main) { if (s.p[0] > S + 1.2) break; keep.push(s); }
    if (!keep.length) keep.push(main[0]);
    const last = keep[keep.length - 1];
    if (sim.main.bounces.filter((b) => b.t <= last.t).length >= 2 || last.p[0] < S - 2) return done(keep);
    const k = FIELDS[field].keeper.at;
    // the keeper moves across to take it on the line it is travelling
    const line = last.p[1] + (last.v[1] / Math.max(1, last.v[0])) * (k[0] - last.p[0]);
    const glove = [k[0] - 0.4, clamp(line, k[1] - 2.5, k[1] + 2.5), clamp(last.p[2] + 0.1, 0.35, 1.9)];
    const T = (glove[0] - last.p[0]) / Math.max(12, last.v[0]);
    const out = keep.slice();
    arcTo(last, glove, T, q, out);
    return done(out, { caughtBy: 'keeper' });
  }

  // everything else starts from the simulated ball up to the moment of contact
  const pre = main.filter((s) => s.t < c.t);
  const at = sample(c.t, c.p, c.v, q);
  at.after = false;
  const out = pre.concat([at]);

  if (hitPad) {
    // dead on the pad: it drops and dribbles toward the off side
    roll(at, [-1.2, 1.4, 0.6], q, 0.7, out);
    return done(out);
  }
  if (res.how === 'chopped-on') {
    const st = sim.main.stumps;
    const y = st ? clamp(st.y, -0.09, 0.09) : 0;
    const to = [S, y, 0.3];
    const T = Math.max(0.03, (S - c.p[0]) / 16);
    const t = arcTo(at, to, T, q, out);
    return done(out, { stumpsTime: t });
  }
  if (res.wicket === 'caught') {
    const kind = res.how === 'caught-behind' ? 'behind' : res.how === 'caught-slip' ? 'slip'
      : outcome.quality === 'top-edge' ? 'top' : outcome.shot;
    const who = res.fielder ? { id: res.fielder, ...FIELDS[field][res.fielder] } : catcher(field, kind);
    const dist = Math.hypot(who.at[0] - c.p[0], who.at[1] - c.p[1]);
    const close = who.id === 'keeper' || who.id.startsWith('slip');
    const to = [who.at[0] - (close ? 0.4 : 0), who.at[1], close ? clamp(c.p[2] + 0.25, 0.4, 1.5) : 1.5];
    // edges fly flat and fast; mishits hang in the air
    const T = close ? dist / Math.max(16, 0.72 * speedIn) : clamp(dist / 17, 1.1, 3.4);
    arcTo(at, to, T, q, out);
    return done(out, { caughtBy: who.id });
  }

  // ---- runs, or a hit that goes nowhere
  let angle, pace, loft;
  const runs = outcome.legal || outcome.extra !== 'wide' ? (outcome.extra === 'noball' ? res.runs - 1 : res.runs) : 0;
  [pace, loft] = PACE[runs] || PACE[1];
  if (outcome.quality === 'outside-edge') {
    angle = spread(runs === 4 ? 163 : 150, 8); // behind square on the off side
    pace = Math.max(pace, runs ? 0.6 * speedIn : 10); loft = runs ? 6 : -2;
  } else if (outcome.quality === 'inside-edge') {
    angle = spread(-158, 10); pace = runs === 4 ? 26 : runs ? 13 : 5; loft = 0;
  } else if (outcome.quality === 'top-edge') {
    angle = spread(-150, 20); pace = runs >= 4 ? 30 : 17; loft = runs >= 4 ? 48 : 62;
  } else if (outcome.quality === 'bottom-edge') {
    angle = spread(0, 60); pace = runs ? 9 : 4; loft = -10;
  } else {
    const [centre, width] = STROKES[outcome.shot] || STROKES.push;
    angle = spread(runs === 6 && outcome.shot === 'drive' ? 0 : centre, width);
    if (runs === 0 && outcome.shot !== 'defend' && outcome.shot !== 'dig') pace = 16; // hit hard, straight at a fielder
  }
  const a = (angle * Math.PI) / 180, e = (loft * Math.PI) / 180;
  const v = [-Math.cos(a) * Math.cos(e) * pace, Math.sin(a) * Math.cos(e) * pace, Math.sin(e) * pace];
  const tMax = runs === 6 ? 3.2 : runs === 4 ? 2.4 : runs >= 1 ? 1.7 : 1.0;
  roll(at, v, q, tMax, out);
  return done(out);
}

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
