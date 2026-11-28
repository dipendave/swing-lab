// Where every joint of a cricketer is. Pure geometry: no graphics, no browser.
//
// Axes are the pitch's: x toward the batter's end, y toward the off side, z up,
// in metres. A figure "faces" +y with its left side toward -x, which is how a
// right-handed batter stands, so the batter's left side is the front side.
//
// A pose is solved in priority order. The bat goes where the stroke needs it.
// The hands stay on the handle. The trunk leans and the hips shift until the
// shoulders are within an arm's length of the hands. The feet stay where they
// were put unless a leg cannot reach, in which case the foot is dragged in.
// Nothing ever stretches: every bone keeps its length.
import { PITCH } from './physics.js';

const CREASE = PITCH.length - PITCH.crease;
const D2R = Math.PI / 180;
const UP = [0, 0, 1];

/** Bone lengths of a 1.82 m adult, metres. */
export const BODY = {
  thigh: 0.44, shin: 0.44, ankle: 0.08, // hip to knee, knee to ankle, ankle above the sole
  ballOfFoot: 0.13, // ankle to the ball of the foot, along the sole
  spine: 0.5, // hip joints up to the shoulder line
  hipHalf: 0.095, shoulderHalf: 0.185,
  upperArm: 0.3, foreArm: 0.29, // forearm measured to the middle of the grip
  head: 0.25, // shoulder line to the centre of the head
};
export const BAT = { length: 0.86, sweet: 0.62, topHand: 0.06, bottomHand: 0.17 };
export const BONES = ['pelvis', 'waist', 'chest', 'head', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];

// ------------------------------------------------------------------- vectors
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => { const t = clamp(k, 0, 1); return t * t * (3 - 2 * t); };
// any direction square to d
const anyPerp = (d) => unit(cross(d, Math.abs(d[2]) < 0.9 ? UP : [1, 0, 0]));
// the part of v that is square to the unit vector d
const perpPart = (v, d) => sub(v, mul(d, dot(v, d)));

/** Turn unit direction a toward unit direction b by fraction k, along the great circle. */
export function swing(a, b, k) {
  const c = clamp(dot(a, b), -1, 1);
  if (c > 0.9999) return unit(mix(a, b, k));
  let axis;
  if (c < -0.9999) axis = anyPerp(a);
  else axis = unit(cross(a, b));
  const ang = Math.acos(c) * k;
  // Rodrigues: a is square to the axis
  return unit(add(mul(a, Math.cos(ang)), mul(cross(axis, a), Math.sin(ang))));
}

// the joint of a two-bone limb (knee, elbow): bones l1 and l2 from `from` to
// `to`, bending toward `pole`. Also returns the normal of the plane it bends in.
function hinge(from, to, l1, l2, pole) {
  const d = sub(to, from);
  const dist = clamp(len(d), 0.06, l1 + l2 - 0.004);
  const dir = len(d) > 1e-6 ? unit(d) : [0, 0, -1];
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  let p = perpPart(pole, dir);
  p = len(p) > 1e-4 ? unit(p) : anyPerp(dir);
  const mid = add(add(from, mul(dir, along)), mul(p, out));
  return { mid, end: add(from, mul(dir, dist)), normal: unit(cross(dir, p)) };
}

// where the ankle is for a foot whose ball stays on the ground while the heel
// lifts by `lift` radians, and which way the sole then points
function footOf(f) {
  const B = BODY, th = f.lift || 0, c = Math.cos(th), s = Math.sin(th);
  const t = unit([f.toe[0], f.toe[1], 0]);
  const g = f.ground || 0;
  const along = B.ballOfFoot * (1 - c) + B.ankle * s;
  return {
    ankle: [f.pos[0] + t[0] * along, f.pos[1] + t[1] * along, g + B.ballOfFoot * s + B.ankle * c],
    dir: unit([t[0] * c, t[1] * c, -s]),
  };
}

/**
 * Solve a whole body.
 *   spec.hipC      midpoint of the hip joints
 *   spec.lean      direction from the hips to the shoulder line
 *   spec.hipAx     direction from the right hip to the left hip
 *   spec.shAx      direction from the right shoulder to the left shoulder
 *   spec.feet      { L, R }: { pos: [x, y], toe: [x, y], lift, ground }
 *   spec.hands     { L, R }: where each hand should be
 *   spec.poles     { kneeL, kneeR, elbowL, elbowR }: which way each joint bends
 *   spec.gazeAt    the point the eyes are on
 *   spec.handHint  { L, R }: a direction each palm wraps around (the bat handle)
 * Returns every joint, plus what frames() needs to orient the bones.
 */
export function solve(spec) {
  const B = BODY;
  const maxLeg = B.thigh + B.shin - 0.006;
  const maxArm = B.upperArm + B.foreArm - 0.012;
  let hipC = spec.hipC.slice();
  let lean = unit(spec.lean);
  const hipAx = unit(spec.hipAx), shAx = unit(spec.shAx);
  const feet = { L: { ...spec.feet.L, pos: spec.feet.L.pos.slice() }, R: { ...spec.feet.R, pos: spec.feet.R.pos.slice() } };
  const side = (s) => (s === 'L' ? 1 : -1);

  // hips no higher than the legs allow
  const settle = () => {
    const top = Math.min(footOf(feet.L).ankle[2], footOf(feet.R).ankle[2]) + maxLeg;
    if (hipC[2] > top) hipC[2] = top;
  };
  settle();

  // lean and shift until both hands are within reach of their shoulders
  for (let i = 0; i < 6; i++) {
    const chest = add(hipC, mul(lean, B.spine));
    let push = [0, 0, 0], n = 0;
    for (const s of ['L', 'R']) {
      const h = spec.hands[s];
      if (!h) continue;
      const d = sub(h, add(chest, mul(shAx, side(s) * B.shoulderHalf)));
      const ex = len(d) - maxArm;
      if (ex > 0) { push = add(push, mul(unit(d), ex)); n++; }
    }
    if (!n) break;
    push = mul(push, 1 / n);
    const want = add(chest, push);
    hipC = [hipC[0] + push[0] * 0.4, hipC[1] + push[1] * 0.4, hipC[2] + push[2] * (push[2] < 0 ? 0.6 : 0.4)];
    settle();
    lean = unit(sub(want, hipC));
    if (lean[2] < 0.3) {
      const h = Math.hypot(lean[0], lean[1]) || 1, k = Math.sqrt(1 - 0.09) / h;
      lean = [lean[0] * k, lean[1] * k, 0.3];
    }
  }
  const chestC = add(hipC, mul(lean, B.spine));

  // the spine curves: the pelvis tilts less than the chest
  const t0 = unit(mix(lean, UP, 0.35));
  const t1 = unit(sub(mul(lean, 2 * dot(lean, t0)), t0));
  const waistC = add(mul(add(hipC, chestC), 0.5), mul(sub(t0, t1), B.spine / 8));

  const out = { hipC, chestC, waistC, lean, t0, t1, hipAx, shAx, L: {}, R: {}, bat: spec.bat || null };

  for (const s of ['L', 'R']) {
    const o = out[s];
    // leg: drag the foot in if it is out of reach
    o.hip = add(hipC, mul(hipAx, side(s) * B.hipHalf));
    let ft = footOf(feet[s]);
    const dz = ft.ankle[2] - o.hip[2];
    const reach = Math.sqrt(Math.max(0.01, maxLeg * maxLeg - dz * dz));
    const hx = ft.ankle[0] - o.hip[0], hy = ft.ankle[1] - o.hip[1], h = Math.hypot(hx, hy);
    if (h > reach) {
      feet[s].pos[0] -= (hx / h) * (h - reach);
      feet[s].pos[1] -= (hy / h) * (h - reach);
      ft = footOf(feet[s]);
    }
    const knee = hinge(o.hip, ft.ankle, B.thigh, B.shin, spec.poles[`knee${s}`]);
    o.knee = knee.mid; o.ankle = knee.end; o.legN = knee.normal; o.footDir = ft.dir;
    o.footPos = feet[s].pos.slice();

    // arm
    o.shoulder = add(chestC, mul(shAx, side(s) * B.shoulderHalf));
    const target = spec.hands[s] || add(o.shoulder, [0, 0, -(B.upperArm + B.foreArm) * 0.97]);
    const elbow = hinge(o.shoulder, target, B.upperArm, B.foreArm, spec.poles[`elbow${s}`]);
    o.elbow = elbow.mid; o.hand = elbow.end; o.armN = elbow.normal;
    o.handHint = (spec.handHint && spec.handHint[s]) || UP;
  }

  // head: carried a little forward of the shoulders, kept more level than the chest
  const front = unit(cross(shAx, t1));
  out.headUp = unit(mix(t1, UP, 0.65));
  out.headC = add(add(chestC, mul(t1, B.head * 0.78)), add(mul(UP, B.head * 0.2), mul(front, 0.025)));
  let g = unit(sub(spec.gazeAt || add(out.headC, front), out.headC));
  // a neck turns only so far: within 80 degrees of where the chest faces, 40 up or down
  const gf = dot(g, front), gl = dot(g, shAx), gu = clamp(dot(g, out.headUp), -0.64, 0.64);
  const yaw = clamp(Math.atan2(gl, gf), -80 * D2R, 80 * D2R);
  const flat = Math.sqrt(1 - gu * gu);
  g = add(add(mul(front, Math.cos(yaw) * flat), mul(shAx, Math.sin(yaw) * flat)), mul(out.headUp, gu));
  out.gaze = unit(perpPart(g, out.headUp));
  return out;
}

// a bone's frame: origin o, y along the bone, z toward `hint`, x = y cross z
function frame(o, y, hint) {
  let x = cross(y, hint);
  x = len(x) > 1e-4 ? unit(x) : anyPerp(y);
  return { o, x, y, z: cross(x, y) };
}
const limbFrame = (o, to, n) => { const y = unit(sub(to, o)); return { o, x: n, y, z: cross(n, y) }; };

/** One frame { o, x, y, z } per entry of BONES for a solved pose. */
export function frames(p) {
  const f = [];
  f.push(frame(p.hipC, p.t0, cross(p.hipAx, p.t0)));
  f.push(frame(p.waistC, p.lean, cross(unit(add(p.hipAx, p.shAx)), p.lean)));
  f.push(frame(p.chestC, p.t1, cross(p.shAx, p.t1)));
  f.push(frame(p.headC, p.headUp, p.gaze));
  for (const s of ['L', 'R']) {
    const o = p[s];
    f.push(limbFrame(o.shoulder, o.elbow, o.armN));
    f.push(limbFrame(o.elbow, o.hand, o.armN));
    f.push(frame(o.hand, unit(sub(o.hand, o.elbow)), o.handHint));
  }
  for (const s of ['L', 'R']) {
    const o = p[s];
    f.push(limbFrame(o.hip, o.knee, o.legN));
    f.push(limbFrame(o.knee, o.ankle, o.legN));
    f.push(frame(o.ankle, o.footDir, UP));
  }
  return f;
}

/** Standing upright, arms a little out from the sides: the pose the body is modelled in. */
export function restPose() {
  const B = BODY;
  const sh = (s) => [-s * B.shoulderHalf, 0, B.thigh + B.shin + B.ankle + B.spine];
  const hang = (s) => add(sh(s), mul(unit([-s * 0.3, 0.04, -1]), (B.upperArm + B.foreArm) * 0.97));
  return solve({
    hipC: [0, 0, B.thigh + B.shin + B.ankle - 0.004],
    lean: UP, hipAx: [-1, 0, 0], shAx: [-1, 0, 0],
    feet: { L: { pos: [-B.hipHalf, 0], toe: [0, 1] }, R: { pos: [B.hipHalf, 0], toe: [0, 1] } },
    hands: { L: hang(1), R: hang(-1) },
    poles: { kneeL: [0, 1, 0], kneeR: [0, 1, 0], elbowL: [0, -1, 0], elbowR: [0, -1, 0] },
    gazeAt: [0, 10, 1.7],
    handHint: { L: [0, 1, 0], R: [0, 1, 0] },
  });
}

// ---------------------------------------------------------------------- batter
const STANCE = {
  top: [CREASE + 0.1, -0.13, 0.8], dir: unit([0.24, 0.06, -0.97]),
  turn: 12, lean: unit([-0.1, 0.3, 0.95]), elbowL: [-0.4, 0.3, -1], elbowR: [0.6, -0.2, -0.8],
};
const LIFTED = {
  top: [CREASE + 0.26, -0.24, 1.02], dir: unit([0.38, -0.12, 0.92]),
  turn: -6, lean: unit([-0.08, 0.28, 0.96]), elbowL: [-0.5, 0.4, -0.6], elbowR: [0.7, -0.3, -0.4],
};
const BOWLERS_HAND = [1.4, 0.4, 2.1];

// blend two bat-and-body keys
function key(a, b, k) {
  if (k <= 0) return a;
  if (k >= 1) return b;
  return {
    top: mix(a.top, b.top, k), dir: swing(a.dir, b.dir, k), turn: lerp(a.turn, b.turn, k),
    lean: unit(mix(a.lean, b.lean, k)), elbowL: mix(a.elbowL, b.elbowL, k), elbowR: mix(a.elbowR, b.elbowR, k),
  };
}

// The stroke as three keys: the moment of contact, an optional halfway point of
// the follow-through, and where the bat finishes.
function stroke(P, forward) {
  const by = clamp(P.bat ? P.bat.y : 0, -0.5, 0.85);
  const bz = clamp(P.bat ? P.bat.z : 0.5, 0.06, 1.75);
  const at = [P.plane, by, bz];
  if (P.kind === 'vertical') {
    let d = unit([0.22, 0, -1]);
    // The hands only go so high. A ball above that is met with the bat angled
    // across, hands in front of the chest, not with the arms above the head.
    const cap = forward ? 1.28 : 1.45;
    if (bz - d[2] * BAT.sweet > cap) {
      const dz = clamp((bz - cap) / BAT.sweet, -0.97, 0.85);
      d = unit([0.12, Math.sqrt(Math.max(0.02, 1 - dz * dz)), dz]);
    }
    const hit = {
      top: sub(at, mul(d, BAT.sweet)), dir: d, turn: P.attack ? 20 : 12,
      lean: forward ? unit([-0.32, 0.28, 0.9]) : unit([-0.04, 0.26, 0.96]),
      elbowL: [-0.8, 0.1, 0.5], elbowR: [0.5, -0.4, -0.7],
    };
    if (!P.attack) return [hit, null, hit];
    const leg = P.shot === 'flick' || P.shot === 'glance';
    const end = leg
      ? { top: [P.plane - 0.1, by - 0.36, 1.36], dir: unit([-0.2, -0.75, 0.62]), turn: 70, lean: unit([-0.12, 0.08, 0.99]), elbowL: [-0.5, -0.6, 0.3], elbowR: [0.4, -0.6, -0.5] }
      : { top: [P.plane + 0.02, by - 0.44, 1.38], dir: unit([0.3, -0.45, 0.84]), turn: 55, lean: unit([-0.2, 0.16, 0.96]), elbowL: [-0.7, 0.2, 0.3], elbowR: [0.3, -0.5, -0.6] };
    return [hit, null, end];
  }
  if (P.kind === 'horizontal') {
    if (P.shot === 'cut') {
      const d = unit([-0.05, 1, -0.08]);
      const hit = { top: sub(at, mul(d, BAT.sweet)), dir: d, turn: 2, lean: unit([0, 0.34, 0.94]), elbowL: [-0.5, 0, -0.8], elbowR: [0.6, -0.4, -0.6] };
      const end = { top: [P.plane - 0.12, by - 0.42, bz + 0.22], dir: unit([-0.72, 0.6, 0.3]), turn: 32, lean: unit([-0.05, 0.22, 0.97]), elbowL: [-0.6, -0.3, -0.5], elbowR: [0.5, -0.5, -0.5] };
      return [hit, null, end];
    }
    const d = unit([-0.62, 0.74, 0.02]);
    const back = P.shot === 'hook' ? unit([0.12, -0.06, 0.99]) : unit([0.04, 0.02, 1]);
    const hit = { top: sub(at, mul(d, BAT.sweet)), dir: d, turn: 52, lean: back, elbowL: [-0.4, -0.3, -0.8], elbowR: [0.6, -0.2, -0.7] };
    const half = { top: [P.plane + 0.2, by - 0.62, bz + 0.05], dir: unit([-0.78, -0.6, 0.18]), turn: 82, lean: back, elbowL: [-0.3, -0.7, -0.5], elbowR: [0.3, -0.6, -0.6] };
    const end = { top: [P.plane + 0.6, by - 0.55, 1.4], dir: unit([0.45, -0.75, 0.48]), turn: 105, lean: back, elbowL: [-0.2, -0.8, 0.2], elbowR: [0.5, -0.5, -0.5] };
    return [hit, half, end];
  }
  if (P.shot === 'duck') {
    const hit = { top: [CREASE + 0.05, -0.34, 0.5], dir: unit([0.9, 0.1, -0.35]), turn: 5, lean: unit([-0.3, 0.72, 0.6]), elbowL: [-0.4, 0.3, -1], elbowR: [0.6, -0.2, -0.8] };
    return [hit, null, hit];
  }
  // leave: bat lifted inside the line, out of harm's way
  const hit = { top: [CREASE - 0.05, -0.36, 1.28], dir: unit([0.28, -0.3, 0.9]), turn: 4, lean: unit([-0.06, 0.16, 0.98]), elbowL: [-0.6, 0.4, -0.3], elbowR: [0.7, -0.3, -0.3] };
  return [hit, null, hit];
}

/**
 * The batter at time t.
 * plan: null for the stance, or { release, contact, plane, shot,
 *   kind: 'vertical' | 'horizontal' | 'none', attack, bat: { y, z } }
 * Returns a solved pose with pose.bat = { top, dir } for the bat.
 */
export function batterPose(plan, t) {
  const P = plan;
  const front = { pos: [CREASE - 0.24, -0.31], toe: [-0.2, 0.98], lift: 0 };
  const back = { pos: [CREASE + 0.3, -0.31], toe: [0.05, 1], lift: 0 };
  let k = STANCE, sink = 0, weight = 0.5, gazeAt = BOWLERS_HAND;

  if (P) {
    const tc = P.contact, tr = P.release;
    const up = ease((t - tr - 0.04) / 0.2); // backlift as the ball is let go
    const down = ease((t - (tc - 0.17)) / 0.17); // the stroke
    const after = ease((t - tc) / 0.26); // follow-through
    const stride = ease((t - (tc - 0.3)) / 0.22);
    const forward = P.plane < CREASE - 0.05;
    const [hit, half, end] = stroke(P, forward);
    const by = clamp(P.bat ? P.bat.y : 0, -0.5, 0.85);
    const pivot = P.kind === 'horizontal' && P.shot !== 'cut';

    if (P.shot === 'duck') sink = 0.3 * down;
    else if (forward) {
      // stride to the pitch of the ball, back heel coming up
      const reach = clamp(CREASE - 0.24 - (P.plane + 0.12), 0, 0.62);
      front.pos = [lerp(front.pos[0], CREASE - 0.24 - reach, stride), lerp(front.pos[1], clamp(by - 0.24, -0.45, 0.3), stride)];
      front.toe = [lerp(-0.2, -0.55, stride), 0.9];
      back.lift = 0.6 * (reach / 0.62) * stride;
      sink = 0.15 * (reach / 0.62) * stride;
      weight = lerp(0.5, 0.62, stride);
    } else {
      // back and across. A cross-bat shot needs room: the body goes where the
      // arms can swing at the ball, deep in the crease or inside its line.
      let bx = CREASE + 0.62, fx = CREASE + 0.1, yb = clamp(by - 0.3, -0.42, 0.1), yf = clamp(by - 0.33, -0.45, 0.06);
      if (P.shot === 'cut') {
        yb = clamp(by - 1.0, -0.62, -0.2); yf = yb - 0.02;
        bx = clamp(P.plane + 0.42, CREASE + 0.3, CREASE + 0.9); fx = bx - 0.52;
      } else if (pivot) {
        yb = clamp(by - 0.3, -0.6, 0.1); yf = yb - 0.03;
        bx = clamp(P.plane + 0.95, CREASE + 0.5, CREASE + 0.95); fx = bx - 0.5;
      }
      back.pos = [lerp(back.pos[0], bx, stride), lerp(back.pos[1], yb, stride)];
      front.pos = [lerp(front.pos[0], fx, stride), lerp(front.pos[1], yf, stride)];
      if (pivot) {
        // the pull swivels on the back foot, the front leg swinging round to leg
        const round = ease((t - (tc - 0.12)) / 0.3);
        front.pos = [front.pos[0] - 0.05 * round, front.pos[1] - 0.22 * round];
        front.toe = [lerp(-0.2, -1, round), lerp(0.98, 0.25, round)];
        back.toe = [lerp(0.05, -0.5, round), 1];
      }
      weight = lerp(0.5, 0.42, stride);
    }

    k = key(STANCE, LIFTED, up);
    if (down > 0) k = key(LIFTED, hit, down);
    if (after > 0) k = half ? (after < 0.5 ? key(hit, half, after * 2) : key(half, end, after * 2 - 1)) : key(hit, end, after);
    // eyes on the bowler's hand, then down onto the ball
    gazeAt = mix(BOWLERS_HAND, [P.plane, by, clamp(P.bat ? P.bat.z : 0.5, 0.06, 1.75)], ease((t - (tc - 0.28)) / 0.22));
    if (P.attack) {
      // then up, after the ball
      const away = P.shot === 'cut' ? [P.plane + 1, by + 8, 1] : P.kind === 'horizontal' || P.shot === 'flick' ? [P.plane - 3, by - 8, 1.6] : [P.plane - 8, by + 2, 1.3];
      gazeAt = mix(gazeAt, away, ease((t - tc - 0.1) / 0.25));
    }
  }

  // the bat never goes through the ground
  let top = k.top.slice();
  const toe = top[2] + k.dir[2] * BAT.length;
  if (toe < 0.012) top[2] += 0.012 - toe;

  const turn = k.turn * D2R, hipTurn = turn * 0.55;
  const spec = {
    hipC: [lerp(back.pos[0], front.pos[0], weight), (front.pos[1] + back.pos[1]) / 2 + 0.04, 0.86 - sink],
    lean: k.lean,
    hipAx: [-Math.cos(hipTurn), -Math.sin(hipTurn), 0],
    shAx: [-Math.cos(turn), -Math.sin(turn), 0],
    feet: { L: front, R: back },
    hands: { L: add(top, mul(k.dir, BAT.topHand)), R: add(top, mul(k.dir, BAT.bottomHand)) },
    poles: { kneeL: [front.toe[0], front.toe[1], 0.25], kneeR: [back.toe[0], back.toe[1], 0.25], elbowL: k.elbowL, elbowR: k.elbowR },
    gazeAt,
    handHint: { L: k.dir, R: k.dir },
    bat: { top, dir: k.dir },
  };
  return solve(spec);
}

// -------------------------------------------------------------------- fielders
// Ready positions, in the fielder's own frame: facing +y, left side toward -x.
const READY = {
  keeper: { hip: 0.5, back: -0.14, lean: [0, 0.6, 0.8], feet: 0.27, hands: [0.065, 0.4, 0.4], toe: 0.45, move: 2.7 },
  close: { hip: 0.62, back: -0.14, lean: [0, 0.6, 0.8], feet: 0.3, hands: [0.06, 0.4, 0.53], toe: 0.35, move: 1.0 },
  ring: { hip: 0.85, back: -0.05, lean: [0, 0.34, 0.94], feet: 0.2, hands: [0.14, 0.3, 0.8], toe: 0.2, move: 1.4 },
  deep: { hip: 0.925, back: 0, lean: [0, 0.06, 1], feet: 0.13, hands: [0.26, 0.04, 0.87], toe: 0.22, move: 1.4 },
};

/**
 * A fielder at time t, in their own frame.
 *   kind  'keeper' | 'close' | 'ring' | 'deep'
 *   plan  null, or { start, time, point }: a ball arriving at `point` (own
 *         frame) at `time`, having left the bat at `start`
 */
export function fielderPose(kind, plan, t) {
  const R = READY[kind] || READY.ring;
  let k = 0, q = null;
  if (plan) {
    const t0 = Math.min(Math.max(plan.start + 0.1, plan.time - 0.6), plan.time - 0.05);
    k = ease((t - t0) / Math.max(0.05, plan.time - t0));
    q = plan.point;
  }
  let root = [0, 0], hip = R.hip, lean = R.lean, gazeAt = [0, 20, 1.2];
  const hands = { L: [-R.hands[0], R.hands[1], R.hands[2]], R: [R.hands[0], R.hands[1], R.hands[2]] };
  if (q && k > 0) {
    // get the body to where the hands can take it a forearm's length in front
    const d = Math.hypot(q[0], q[1]);
    const go = Math.min(Math.max(0, d - 0.36), R.move) * k;
    if (d > 1e-6) root = [(q[0] / d) * go, (q[1] / d) * go];
    hip = lerp(R.hip, clamp(q[2] - 0.32, 0.46, 0.925), k);
    lean = unit(mix(R.lean, [(q[0] - root[0]) * 0.3, 0.12 + (q[1] - root[1]) * 0.2, 0.95], k));
    hands.L = mix(hands.L, [q[0] - 0.045, q[1], q[2]], k);
    hands.R = mix(hands.R, [q[0] + 0.045, q[1], q[2]], k);
    gazeAt = mix(gazeAt, q, Math.min(1, k * 3));
  }
  const cup = kind === 'deep' && !k ? [0, 1, 0] : [1, 0, 0];
  return solve({
    hipC: [root[0], root[1] + R.back * (1 - k * 0.6), hip],
    lean, hipAx: [-1, 0, 0], shAx: [-1, 0, 0],
    feet: {
      L: { pos: [root[0] - R.feet, root[1]], toe: [-R.toe, 1] },
      R: { pos: [root[0] + R.feet, root[1]], toe: [R.toe, 1] },
    },
    hands,
    poles: { kneeL: [-R.toe - 0.15, 1, 0.1], kneeR: [R.toe + 0.15, 1, 0.1], elbowL: [-0.8, -0.5, -0.3], elbowR: [0.8, -0.5, -0.3] },
    gazeAt,
    handHint: { L: cup, R: cup },
  });
}

export const _vec = { add, sub, mul, dot, len, unit, mix, cross, clamp, lerp, ease };
