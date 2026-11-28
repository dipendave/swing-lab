// The batter. Pure logic, no browser APIs, seeded randomness: the same ball
// against the same batter with the same seed always ends the same way.
//
// How a ball is played
// --------------------
// 1. The batter judges the length early and chooses where to meet the ball:
//    a long stride forward for a full one, back in the crease for a short one,
//    somewhere unhappy in between for a good length.
// 2. A fixed time before the ball arrives the batter has to commit. From that
//    instant they expect the ball to carry on as it is going: no further swing
//    beyond part of the curve they have already seen, and a plain bounce.
// 3. The bat goes where that expectation says the ball will be, pulled part of
//    the way toward the truth by late adjustment and blurred by ordinary human
//    error.
// 4. The real ball arrives where the physics puts it. The gap between ball and
//    bat decides everything: middle, edge or miss, and which edge.
//
// So late swing finds the outside or inside edge, seam movement off a good
// length beats the bat because the ball pitches after the batter has committed,
// and a short ball is easy to line up because there is time to see it after
// the bounce. None of that is scripted; it follows from steps 2 and 4.
import { BALL, PITCH, expectedPath } from './physics.js';
import { catcher } from './field.js';

const S = PITCH.length; // batter's stumps
const CREASE = S - PITCH.crease; // batter's popping crease
const HALF = PITCH.stumpsHalfWidth;

/** The playing conditions this mode uses (limited-overs interpretations). */
export const RULES = {
  wideOff: 0.89, // m from middle stump: the painted wide guideline
  wideLeg: -0.5, // anything further down the leg side than the batter's body
  headHigh: 1.85, // a bouncer passing above this at the crease is a wide
  waistHigh: 1.04, // a full toss passing above this at the crease is a no-ball
};

/** A competent club-to-county batter: sound, not brilliant. */
export const SKILL = {
  commit: 0.22, // s before contact that the shot is decided
  anticipation: 0.4, // share of the swing already seen that is carried forward
  curveBlur: 0.06, // extra misjudgement per unit of swing still to come
  perception: 0.012, // m, error in reading where the ball will be
  execution: 0.018, // m, error in putting the bat where intended
  lengthRead: 0.2, // m, error in the early read of length
};

// bat geometry: 10.8 cm wide blade
const MIDDLE = 0.022; // m off centre that still comes out of the middle
const OFF_CENTRE = 0.048; // beyond this the edge is involved
const EDGE = 0.084; // beyond this the ball misses the bat altogether
const UNDER = 0.07; // a yorker this far below where the bat was aimed gets under it

// per shot: how much the batter can still adjust after committing, and how much
// harder the shot is to execute than a dead-bat defence
export const SHOTS = {
  defend: { adjust: 0.4, risk: 1.0, bat: 'vertical', attack: false },
  push: { adjust: 0.3, risk: 1.15, bat: 'vertical', attack: false },
  glance: { adjust: 0.3, risk: 1.15, bat: 'vertical', attack: false },
  flick: { adjust: 0.2, risk: 1.35, bat: 'vertical', attack: true },
  dig: { adjust: 0.25, risk: 1.3, bat: 'vertical', attack: false },
  drive: { adjust: 0.15, risk: 1.45, bat: 'vertical', attack: true },
  cut: { adjust: 0.15, risk: 1.5, bat: 'horizontal', attack: true },
  pull: { adjust: 0.15, risk: 1.6, bat: 'horizontal', attack: true },
  hook: { adjust: 0.1, risk: 1.9, bat: 'horizontal', attack: true },
  slog: { adjust: 0.05, risk: 2.1, bat: 'horizontal', attack: true },
  leave: { adjust: 0, risk: 0, bat: 'none', attack: false },
  duck: { adjust: 0, risk: 0, bat: 'none', attack: false },
};

// What a clean or slightly off-centre hit is worth. Keys are runs; C is caught
// in the field. "slips" is an attacking field with catchers and gaps in front;
// "spread" has boundary riders and no slips.
const RUNS = {
  defend: {
    middle: { slips: { 0: 90, 1: 10 }, spread: { 0: 88, 1: 12 } },
    off: { slips: { 0: 82, 1: 18 }, spread: { 0: 80, 1: 20 } },
  },
  push: {
    middle: { slips: { 0: 30, 1: 45, 2: 15, 4: 10 }, spread: { 0: 25, 1: 60, 2: 13, 4: 2 } },
    off: { slips: { 0: 55, 1: 40, 2: 5 }, spread: { 0: 50, 1: 45, 2: 5 } },
  },
  glance: {
    middle: { slips: { 0: 10, 1: 45, 2: 15, 4: 30 }, spread: { 0: 10, 1: 65, 2: 15, 4: 10 } },
    off: { slips: { 0: 40, 1: 50, 2: 10 }, spread: { 0: 40, 1: 52, 2: 8 } },
  },
  flick: {
    middle: { slips: { 0: 8, 1: 25, 2: 12, 4: 45, 6: 10 }, spread: { 0: 6, 1: 42, 2: 17, 4: 22, 6: 13 } },
    off: { slips: { 0: 30, 1: 40, 2: 12, 4: 8, C: 10 }, spread: { 0: 26, 1: 42, 2: 12, 4: 6, C: 14 } },
  },
  dig: {
    middle: { slips: { 0: 50, 1: 40, 2: 5, 4: 5 }, spread: { 0: 48, 1: 45, 2: 5, 4: 2 } },
    off: { slips: { 0: 72, 1: 28 }, spread: { 0: 70, 1: 30 } },
  },
  drive: {
    middle: { slips: { 0: 12, 1: 15, 2: 15, 4: 55, 6: 3 }, spread: { 0: 8, 1: 34, 2: 20, 4: 34, 6: 4 } },
    off: { slips: { 0: 35, 1: 35, 2: 15, 4: 9, C: 6 }, spread: { 0: 30, 1: 45, 2: 15, 4: 4, C: 6 } },
  },
  cut: {
    middle: { slips: { 0: 15, 1: 20, 2: 10, 4: 55 }, spread: { 0: 10, 1: 45, 2: 15, 4: 30 } },
    off: { slips: { 0: 40, 1: 38, 2: 10, 4: 4, C: 8 }, spread: { 0: 38, 1: 40, 2: 10, 4: 4, C: 8 } },
  },
  pull: {
    middle: { slips: { 0: 10, 1: 22, 2: 8, 4: 45, 6: 15 }, spread: { 0: 8, 1: 40, 2: 12, 4: 22, 6: 18 } },
    off: { slips: { 0: 28, 1: 35, 2: 12, 4: 10, C: 15 }, spread: { 0: 22, 1: 38, 2: 12, 4: 6, C: 22 } },
  },
  hook: {
    middle: { slips: { 0: 10, 1: 20, 4: 30, 6: 35, C: 5 }, spread: { 0: 8, 1: 30, 4: 22, 6: 30, C: 10 } },
    off: { slips: { 0: 25, 1: 30, 4: 10, 6: 5, C: 30 }, spread: { 0: 22, 1: 30, 4: 8, 6: 5, C: 35 } },
  },
  slog: {
    middle: { slips: { 0: 5, 1: 10, 2: 10, 4: 35, 6: 40 }, spread: { 0: 5, 1: 18, 2: 14, 4: 25, 6: 38 } },
    off: { slips: { 0: 20, 1: 25, 2: 13, 4: 10, 6: 2, C: 30 }, spread: { 0: 18, 1: 25, 2: 13, 4: 8, 6: 2, C: 34 } },
  },
};

// ------------------------------------------------------------------ utilities
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const cm = (m) => Math.round(Math.abs(m) * 100);

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function pick(table, rng) {
  let total = 0;
  for (const k in table) total += table[k];
  let r = rng() * total;
  for (const k in table) {
    r -= table[k];
    if (r <= 0) return k;
  }
  return Object.keys(table)[0];
}

function blend(a, b, k) {
  return {
    t: lerp(a.t, b.t, k),
    p: [lerp(a.p[0], b.p[0], k), lerp(a.p[1], b.p[1], k), lerp(a.p[2], b.p[2], k)],
    v: [lerp(a.v[0], b.v[0], k), lerp(a.v[1], b.v[1], k), lerp(a.v[2], b.v[2], k)],
    q: a.q, w: a.w,
  };
}

/** The ball as it first crosses the plane x on its way to the batter. */
export function atPlane(samples, x) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.p[0] < x && b.p[0] >= x) return blend(a, b, (x - a.p[0]) / (b.p[0] - a.p[0]));
  }
  return null;
}

/** The ball at time t. Never returns a blend across the instant of a bounce. */
export function atTime(samples, t) {
  if (t <= samples[0].t) return samples[0];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.t >= t) {
      if (a.bounce) return b; // a holds the velocity going into the pitch
      return blend(a, b, b.t > a.t ? (t - a.t) / (b.t - a.t) : 0);
    }
  }
  return samples[samples.length - 1];
}

// where the batter chooses to meet the ball, as a distance past the popping
// crease (negative is a stride toward the bowler), from the length they read
const FOOTWORK = [[-2, -0.25], [1.4, -0.35], [3, -1.3], [5.5, -1.3], [7, -0.9], [7.8, 0.15], [20, 0.15]];
function footwork(length) {
  for (let i = 1; i < FOOTWORK.length; i++) {
    const [l0, o0] = FOOTWORK[i - 1], [l1, o1] = FOOTWORK[i];
    if (length <= l1) return lerp(o0, o1, clamp((length - l0) / (l1 - l0), 0, 1));
  }
  return 0.15;
}

/**
 * How hard the batter is trying to score, 0 to 1, from the match situation.
 * ctx.aggression, when given, overrides it (a batter blocking for a draw).
 */
export function aggression(ctx) {
  if (typeof ctx.aggression === 'number') return ctx.aggression;
  if (!Number.isFinite(ctx.need) || ctx.ballsLeft <= 0) return 0.3;
  const perBall = ctx.need / ctx.ballsLeft;
  let a = clamp(0.18 + 0.42 * (perBall - 0.5), 0.12, 1);
  if (ctx.wicketsLeft <= 1) a *= 0.9;
  return a;
}

// ------------------------------------------------------------------ the shot
function chooseShot(read, a, rng) {
  const { y, z, length, threat } = read;
  if (z > RULES.headHigh) return 'duck';
  if (y > 0.8 || y < -0.55) return 'leave';
  const onPads = y < -0.2;
  const wideOfOff = y > 0.38;
  // a batter who needs runs works the ball around; one who does not, blocks it
  const quiet = a >= 0.4 ? 'push' : 'defend';
  // letting the ball go is for batters with time on their side
  const mayLeave = !threat && a < 0.35 && rng() < 0.8 * (1 - a);

  if (length < 0.5 && z > 0.25) {
    // a full toss: a missed yorker, and a gift
    if (onPads) return rng() < 0.15 + 0.75 * a ? 'flick' : 'glance';
    if (rng() < 0.5 + 0.5 * a) return z > 0.75 ? 'pull' : a > 0.7 && rng() < 0.5 ? 'slog' : 'drive';
    return 'push';
  }
  if (length < 1.6) {
    // yorker length: get the bat down, or back yourself to hit it
    return rng() < 0.45 * a * a ? 'slog' : 'dig';
  }
  if (length < 5.2 && z < 0.8) {
    // overpitched: the ball to hit
    if (onPads) return rng() < 0.15 + 0.75 * a ? 'flick' : 'glance';
    if (rng() < 0.3 + 0.65 * a) return a > 0.8 && rng() < 0.5 ? 'slog' : 'drive';
    if (wideOfOff && mayLeave) return 'leave';
    return threat || Math.abs(y) < 0.28 ? quiet : 'push';
  }
  if (length < 7.8 && z < 1.05) {
    // good length: the hard one
    if (onPads) return rng() < 0.6 * a ? 'flick' : 'glance';
    if (wideOfOff && mayLeave) return 'leave';
    const attack = Math.max(0, a - 0.25) * 1.15;
    if (rng() < attack) return a > 0.8 && rng() < 0.5 ? 'slog' : wideOfOff ? 'cut' : 'drive';
    if (threat || Math.abs(y) < 0.28) return quiet;
    return 'push';
  }
  // short of a length and shorter, played off the back foot
  if (z > 1.55) return rng() < 0.2 + 0.7 * a ? 'hook' : 'duck';
  if (y > 0.32) return rng() < 0.3 + 0.65 * a || !mayLeave ? 'cut' : 'leave';
  if (z > 0.95) return rng() < 0.25 + 0.7 * a ? 'pull' : 'defend';
  if (onPads) return 'glance';
  return rng() < 0.5 * a ? 'pull' : threat && a < 0.4 ? 'defend' : 'push';
}

// ---------------------------------------------------------------- the result
function result(runs, wicket, how, detail, fielder = null) {
  return { runs, wicket, how, detail, fielder, boundary: runs === 4 || runs === 6 };
}

const HIT_TEXT = {
  defend: ['Blocked', 'Defended and a quick single', '', '', '', '', ''],
  push: ['Pushed to a fielder', 'Pushed for a single', 'Placed into the gap for two', '', 'Timed through the gap', '', ''],
  glance: ['Worked to leg, no run', 'Worked off the pads for one', 'Clipped away for two', '', 'Glanced fine for four', '', ''],
  flick: ['Flicked straight to a fielder', 'Flicked for a single', 'Flicked into the gap for two', '', 'Flicked through midwicket', '', 'Flicked over square leg'],
  dig: ['Dug out', 'Dug out for a single', 'Squeezed away for two', '', 'Squeezed past the keeper', '', ''],
  drive: ['Driven straight to a fielder', 'Driven for a single', 'Driven into the gap for two', '', 'Driven through the covers', '', 'Driven back over the bowler'],
  cut: ['Cut straight to point', 'Cut away for one', 'Cut behind point for two', '', 'Cut away square', '', ''],
  pull: ['Pulled straight to a fielder', 'Pulled for a single', 'Pulled away for two', '', 'Pulled through midwicket', '', 'Pulled over square leg'],
  hook: ['Hooked, straight to a fielder', 'Hooked for a single', '', '', 'Hooked fine', '', 'Hooked over fine leg'],
  slog: ['Swung hard, straight to a fielder', 'Heaved away for one', 'Heaved into the gap for two', '', 'Heaved over midwicket', '', 'Launched over long-on'],
};
const CAUGHT_VERB = { drive: 'Driven', cut: 'Cut', pull: 'Pulled', flick: 'Flicked', hook: 'Hooked', slog: 'Skied' };

/**
 * Play one delivery.
 *   sim   result of simulate(cfg): the ball with nobody in the way
 *   cfg   the settings that ball was bowled with
 *   ctx   { need, ballsLeft, wicketsLeft, field: 'slips' | 'spread', aggression? }
 *   rng   () => number in [0, 1)
 * Returns what happened and why. Distances are metres in pitch axes: x toward
 * the batter's end, y toward the off side, z up.
 */
export function faceBall(sim, cfg, ctx, rng) {
  const samples = sim.main.samples;
  const bounces = sim.main.bounces;
  const field = ctx.field === 'spread' ? 'spread' : 'slips';
  const a = aggression(ctx);
  const out = {
    legal: true, extra: null, shot: null, quality: null,
    contact: null, bat: null, plane: null,
    read: null, lateMove: 0, bounceSurprise: 0, miss: 0,
    result: null, text: null, aggression: a,
  };
  const finish = (res, why) => {
    out.result = res;
    out.text = describe(out, res, why);
    return out;
  };

  // ---- is it a legal ball? Decided by where the real ball went.
  const crease = sim.main.crease;
  const pitchedBefore = bounces.filter((b) => b.p[0] < CREASE).length;
  const freeHit = () => Number(pick({ 1: 12, 2: 8, 4: 50, 6: 30 }, rng));
  if (!crease) {
    out.legal = false; out.extra = 'noball'; out.shot = 'slog';
    out.contact = samples[samples.length - 1];
    return finish(result(1 + freeHit(), null, 'noball', 'No-ball, and it is hit away'), 'It never reached the batter.');
  }
  if (pitchedBefore >= 2) {
    out.legal = false; out.extra = 'noball'; out.shot = 'slog';
    out.contact = atPlane(samples, CREASE - 0.3) || crease;
    return finish(result(1 + freeHit(), null, 'noball', 'No-ball, and it is hit away'), 'It bounced twice before the batter.');
  }
  if (pitchedBefore === 0 && crease.z > RULES.waistHigh) {
    out.legal = false; out.extra = 'noball'; out.shot = 'slog';
    out.contact = atPlane(samples, CREASE - 0.3) || crease;
    return finish(result(1 + freeHit(), null, 'noball', 'No-ball, and it is hit away'), 'A full toss above waist height.');
  }

  // ---- the early read of length, and where to meet the ball
  const first = bounces[0] && bounces[0].p[0] < S + 1 ? bounces[0] : null;
  const trueLength = first ? S - first.p[0] : -1;
  const lengthRead = trueLength + SKILL.lengthRead * gaussian(rng);
  const plane = CREASE + footwork(lengthRead);
  out.plane = plane;
  const real = atPlane(samples, plane);
  if (!real) {
    out.legal = false; out.extra = 'noball'; out.shot = 'slog';
    out.contact = samples[samples.length - 1];
    return finish(result(1 + freeHit(), null, 'noball', 'No-ball, and it is hit away'), 'It never reached the batter.');
  }
  out.contact = real;
  const speed = Math.hypot(real.v[0], real.v[1], real.v[2]);

  // ---- the instant of commitment, and what the batter expects from there
  const tSee = Math.max(samples[0].t + 0.06, real.t - SKILL.commit);
  const seen = atTime(samples, tSee);
  const expected = expectedPath(cfg, seen);
  const guess = atPlane(expected.samples, plane);
  let ey, ez, tGuess;
  let swingCarried = 0;
  if (guess) {
    // carry forward part of the curve already seen
    const earlier = atTime(samples, seen.t - 0.07);
    const dt = seen.t - earlier.t;
    const bounced = bounces.some((b) => b.t > earlier.t && b.t <= seen.t);
    const curve = dt > 0.02 && !bounced ? (seen.v[1] - earlier.v[1]) / dt : 0;
    const left = Math.max(0, guess.t - seen.t);
    const nextBounce = expected.bounces.find((b) => b.p[0] < plane);
    const swinging = nextBounce ? clamp(nextBounce.t - seen.t, 0, left) : left;
    swingCarried = SKILL.anticipation * curve * (0.5 * swinging * swinging + swinging * (left - swinging));
    ey = guess.p[1] + swingCarried;
    ez = guess.p[2];
    tGuess = guess.t;
  } else {
    ey = real.p[1]; ez = real.p[2]; tGuess = real.t;
  }
  out.lateMove = real.p[1] - ey; // sideways movement the batter did not allow for
  out.bounceSurprise = real.p[2] - ez; // higher (+) or lower (-) than expected

  // how the batter reads it, with human error. Pace makes everything harder,
  // and a ball that pitches right at the feet is hard to judge for height.
  const paceFactor = 0.75 + speed / 120;
  const atTheFeet = first && Math.abs(real.t - first.t) < 0.1 ? 1.4 : 1;
  // a ball that is curving is harder to place than one going straight
  const stillToSwing = guess ? Math.abs(swingCarried) / SKILL.anticipation : 0;
  const readY = ey + (SKILL.perception * paceFactor + SKILL.curveBlur * stillToSwing) * gaussian(rng);
  const readZ = ez + SKILL.perception * 1.2 * paceFactor * atTheFeet * gaussian(rng);

  // will it hit the stumps, as far as the batter can tell?
  let threat = false;
  if (expected.stumps) {
    const k = guess && guess.t > seen.t ? ((expected.stumps.t - seen.t) / (guess.t - seen.t)) ** 2 : 1;
    const sy = expected.stumps.y + swingCarried * clamp(k, 1, 3);
    threat = Math.abs(sy) <= HALF + 0.05 && expected.stumps.z <= PITCH.stumpHeight + 0.06;
  }
  out.read = { y: readY, z: readZ, length: lengthRead, threat };

  // ---- shot, and where the bat actually goes
  const shot = chooseShot(out.read, a, rng);
  out.shot = shot;
  const spec = SHOTS[shot];
  // wides are judged where the ball passes the batter's crease
  const wide = crease.y > RULES.wideOff || crease.y < RULES.wideLeg || crease.z > RULES.headHigh;
  const stumpsHit = sim.main.hitStumps;
  const pitchedOutsideLeg = first ? first.p[1] < -HALF : false;

  if (spec.bat === 'none') {
    out.quality = 'none';
    if (wide) {
      out.legal = false; out.extra = 'wide';
      const by = crease.z > RULES.headHigh ? 'Over head height.'
        : crease.y > 0 ? `${cm(crease.y - RULES.wideOff)} cm outside the wide line.`
          : 'Down the leg side, past the batter.';
      return finish(result(1, null, 'wide', 'Wide'), by);
    }
    // Leaving with the pads in the way. No shot is offered, so being hit outside
    // the line of off stump is no defence (Law 36).
    const padded = shot === 'leave' && real.p[1] > -0.23 && real.p[1] < 0.03 && real.p[2] < 0.72;
    if (padded) {
      if (pitchedOutsideLeg) return finish(result(0, null, 'pad', 'Padded away, not out'), 'It pitched outside leg stump.');
      if (real.p[1] < -HALF) return finish(result(0, null, 'pad', 'Padded away, not out'), 'Hit outside the line of leg stump.');
      if (stumpsHit) return finish(result(0, 'lbw', 'lbw', 'Padded up, leg before wicket'), null);
      return finish(result(0, null, 'pad', 'Padded away, not out'), 'It was missing the stumps.');
    }
    if (stumpsHit) return finish(result(0, 'bowled', 'bowled', 'Left alone, and it hit the stumps'), null);
    return finish(result(0, null, 'leave', shot === 'duck' ? 'Ducked under it' : 'Left alone'), null);
  }

  const reaching = Math.abs(readY) > 0.5 ? 1.3 : 1;
  // Length decides how hard an attacking stroke is. A half-volley is there to
  // be hit; driving or heaving at a good-length ball means hitting on the up.
  let lengthFit = 1;
  if (spec.attack && (shot === 'drive' || shot === 'flick' || shot === 'slog')) {
    if (lengthRead >= 2.2 && lengthRead < 5.2) lengthFit = 0.75;
    else if (lengthRead >= 5.2 && lengthRead < 7.8) lengthFit = 1.3;
  }
  const sigma = SKILL.execution * spec.risk * reaching * lengthFit * paceFactor;
  // The longer the ball is in view after pitching, the more of a late deviation
  // the hands can follow: a short ball can be adjusted to, a full one cannot.
  const afterPitch = first && first.t < real.t ? real.t - first.t : 0;
  const adjust = Math.min(0.85, spec.adjust * (1 + 0.75 * clamp((afterPitch - 0.06) / 0.12, 0, 1)));
  const batY = readY + adjust * (real.p[1] - readY) + sigma * gaussian(rng);
  const batZ = readZ + adjust * (real.p[2] - readZ) + sigma * 1.2 * atTheFeet * gaussian(rng);
  const missY = real.p[1] - batY; // + means the ball is on the off side of the bat
  const missZ = real.p[2] - batZ; // + means the ball is above the bat
  out.bat = { y: batY, z: batZ, kind: spec.bat };

  // timing: an attacking shot through the ball too early or too late loses its shape
  const timing = real.t - tGuess + 0.006 * gaussian(rng);
  const mistimed = spec.attack && Math.abs(timing) > 0.014;

  let quality;
  const m = spec.bat === 'horizontal' ? missZ : missY;
  out.miss = m;
  if (shot === 'dig' && missZ < -UNDER) quality = 'miss'; // under the bat
  else if (Math.abs(m) <= MIDDLE) quality = mistimed ? 'off' : 'middle';
  else if (Math.abs(m) <= OFF_CENTRE) quality = 'off';
  else if (Math.abs(m) <= EDGE) {
    quality = spec.bat === 'horizontal' ? (m > 0 ? 'top-edge' : 'bottom-edge') : (m > 0 ? 'outside-edge' : 'inside-edge');
  } else quality = 'miss';
  out.quality = quality;

  // an off-side wide the batter could not reach is still a wide
  if (quality === 'miss' && wide) {
    out.legal = false; out.extra = 'wide';
    return finish(result(1, null, 'wide', 'Wide, swung at and missed'), null);
  }

  // ---- clean and off-centre hits
  if (quality === 'middle' || quality === 'off') {
    const drawn = pick(RUNS[shot][quality][field], rng);
    if (drawn === 'C') {
      const who = catcher(field, shot);
      return finish(result(0, 'caught', 'caught-field', `${CAUGHT_VERB[shot]} to ${who.label}, caught`, who.id), null);
    }
    const runs = Number(drawn);
    return finish(result(runs, null, 'hit', HIT_TEXT[shot][runs] || `${runs} run${runs === 1 ? '' : 's'}`), null);
  }

  // ---- edges
  const nearStumps = sim.main.stumps && Math.abs(sim.main.stumps.y) < HALF + 0.14 && sim.main.stumps.z < 0.85;
  if (quality === 'outside-edge') {
    const thin = Math.abs(m) > (OFF_CENTRE + EDGE) / 2;
    // a quicker ball flies off the edge; a dead-bat defence takes pace off it
    const carry = clamp((speed - 20) / 14, 0.1, 0.95) * (shot === 'defend' ? 0.75 : 1);
    if (thin) {
      if (rng() < carry * 0.9) return finish(result(0, 'caught', 'caught-behind', 'Thin edge, caught behind', 'keeper'), null);
      return finish(result(0, null, 'edge', 'Edged, short of the keeper'), null);
    }
    if (field === 'slips') {
      if (rng() < carry * 0.65) return finish(result(0, 'caught', 'caught-slip', 'Outside edge, caught at slip', 'slip2'), null);
      const r = Number(pick({ 0: 40, 1: 25, 4: 35 }, rng));
      return finish(result(r, null, 'edge', r === 4 ? 'Edged through the slips' : r ? 'Edged wide of slip for one' : 'Edged, short of slip'), null);
    }
    const r = Number(pick({ 1: 60, 2: 15, 4: 25 }, rng));
    return finish(result(r, null, 'edge', r === 4 ? 'Edged past the keeper' : `Edged to third man for ${r === 1 ? 'one' : 'two'}`), null);
  }
  if (quality === 'inside-edge') {
    if (nearStumps && rng() < 0.22) return finish(result(0, 'bowled', 'chopped-on', 'Inside edge onto the stumps'), null);
    const r = Number(pick({ 0: 55, 1: 35, 4: 10 }, rng));
    return finish(result(r, null, 'edge', r === 4 ? 'Inside edge, past the stumps' : r ? 'Inside edge for a single' : 'Inside edge onto the pad'), null);
  }
  if (quality === 'top-edge') {
    if (rng() < (field === 'spread' ? 0.6 : 0.4)) return finish(result(0, 'caught', 'caught-field', 'Top edge, caught at fine leg', 'fineLeg'), null);
    const r = Number(pick({ 1: 45, 2: 18, 4: 25, 6: 12 }, rng));
    return finish(result(r, null, 'edge', r >= 4 ? 'Top edge, over the keeper' : `Top edge, lands safe for ${r === 1 ? 'one' : 'two'}`), null);
  }
  if (quality === 'bottom-edge') {
    if (nearStumps && rng() < 0.15) return finish(result(0, 'bowled', 'chopped-on', 'Bottom edge onto the stumps'), null);
    const r = Number(pick({ 0: 60, 1: 40 }, rng));
    return finish(result(r, null, 'edge', r ? 'Bottom edge for a single' : 'Bottom edge into the ground'), null);
  }

  // ---- beaten. What is behind the bat?
  if (spec.bat === 'horizontal') {
    if (stumpsHit) return finish(result(0, 'bowled', 'bowled', 'Swung across it, bowled'), null);
    return finish(result(0, null, 'beaten', missZ > 0 ? 'Swung under it' : 'Swung over it'), null);
  }
  // Vertical bat. A ball that beats the inside edge finds the front pad if it is
  // close enough to the bat; a wider gap is "the gate".
  // The front pad sits on the leg side of the bat with a little daylight between
  // them. A ball that beats the inside edge goes through that gap only if the
  // gap is wider than the ball; otherwise it hits the pad.
  const inside = missY < 0;
  const past = Math.abs(missY) - 0.054; // m from the edge of the bat to the middle of the ball
  const gate = 0.12 * rng(); // m of daylight between bat and pad: usually not much
  const throughGate = inside && past + BALL.radius < gate; // the whole ball fits through
  const onPad = inside && !throughGate && past < gate + 0.18;
  const under = shot === 'dig' && missZ < -UNDER && Math.abs(missY) <= EDGE;
  if (under) {
    if (stumpsHit) return finish(result(0, 'bowled', 'bowled', 'Yorked, under the bat'), null);
    return finish(result(0, null, 'beaten', 'Under the bat, missing the stumps'), null);
  }
  if (onPad && real.p[2] < 0.72) {
    // leg before wicket, Law 36
    if (pitchedOutsideLeg) return finish(result(0, null, 'pad', 'Struck on the pad, not out'), 'It pitched outside leg stump.');
    if (real.p[1] > HALF) return finish(result(0, null, 'pad', 'Struck on the pad, not out'), 'Hit outside the line, playing a shot.');
    if (real.p[1] < -HALF) return finish(result(0, null, 'pad', 'Struck on the pad, not out'), 'Hit outside the line of leg stump.');
    if (!stumpsHit) {
      const over = sim.main.stumps && sim.main.stumps.z > PITCH.stumpHeight + BALL.radius * 0.7;
      return finish(result(0, null, 'pad', 'Struck on the pad, not out'), over ? 'It was going over the stumps.' : 'It was missing the stumps.');
    }
    return finish(result(0, 'lbw', 'lbw', 'Leg before wicket'), null);
  }
  if (stumpsHit) {
    return finish(result(0, 'bowled', 'bowled', inside ? 'Bowled through the gate' : 'Beaten on the outside, bowled'), null);
  }
  return finish(result(0, null, 'beaten', inside ? 'Beaten on the inside edge' : 'Beaten outside the edge'), null);
}

// ------------------------------------------------------------------- wording
// headline and detail are short enough to sit on one line each in the readout
function describe(out, res, whyOverride) {
  let headline;
  if (res.how === 'wide') headline = 'Wide';
  else if (res.how === 'noball') headline = `No-ball, ${res.runs} in all`;
  else if (res.wicket) headline = 'Wicket';
  else if (res.runs === 0) headline = 'Dot ball';
  else if (res.runs === 4) headline = 'Four';
  else if (res.runs === 6) headline = 'Six';
  else headline = `${res.runs} run${res.runs === 1 ? '' : 's'}`;

  let why = whyOverride;
  if (!why) {
    const late = Math.abs(out.lateMove), bounce = Math.abs(out.bounceSurprise);
    if (late >= 0.03 && late >= bounce) why = `Moved ${cm(late)} cm after the batter committed.`;
    else if (bounce >= 0.04) why = out.bounceSurprise > 0 ? `Bounced ${cm(bounce)} cm more than expected.` : `Kept ${cm(bounce)} cm lower than expected.`;
    else if (res.wicket || out.quality === 'miss' || (out.quality || '').endsWith('edge')) why = 'No late movement: the batter\'s mistake.';
    else why = 'Nothing late in it. Easy to line up.';
  }
  return { headline, detail: res.detail, why };
}
