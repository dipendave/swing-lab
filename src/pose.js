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

/**
 * Bone lengths, metres: those of the model in assets/figure, which stands
 * 1.82 m in its boots. tests/figure.test.js holds the two to each other.
 */
export const BODY = {
  thigh: 0.434, shin: 0.454, ankle: 0.092, // hip to knee, knee to ankle, ankle above the sole
  ballOfFoot: 0.14, // ankle to the ball of the foot, along the sole
  spine: 0.48, // hip joints up to the shoulder line
  hipHalf: 0.113, shoulderHalf: 0.194,
  upperArm: 0.262, foreArm: 0.337, // forearm measured to the middle of the palm
  head: 0.252, headFwd: 0.025, // shoulder line to the centre of the head, and how far forward it is carried
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
  // no nearer than the two bones can fold, no farther than they can reach
  const dist = clamp(len(d), Math.max(0.06, Math.abs(l1 - l2) + 0.02), l1 + l2 - 0.004);
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

// The trunk between the hips and the shoulder line, and the head on top of it.
// The spine curves: the pelvis tilts less than the chest. The head is carried a
// little forward of the shoulders and kept more level than the chest.
function trunk(hipC, chestC, lean, shAx) {
  const B = BODY;
  const t0 = unit(mix(lean, UP, 0.35));
  const t1 = unit(sub(mul(lean, 2 * dot(lean, t0)), t0));
  const waistC = add(mul(add(hipC, chestC), 0.5), mul(sub(t0, t1), B.spine / 8));
  const front = unit(cross(shAx, t1));
  const headUp = unit(mix(t1, UP, 0.65));
  const headC = add(add(chestC, mul(t1, B.head * 0.78)), add(mul(UP, B.head * 0.2), mul(front, B.headFwd)));
  return { t0, t1, waistC, front, headUp, headC };
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
  const minArm = Math.abs(B.upperArm - B.foreArm) + 0.035;
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

  // lean and shift until both hands are where their arms can put them
  for (let i = 0; i < 6; i++) {
    const chest = add(hipC, mul(lean, B.spine));
    let push = [0, 0, 0], n = 0;
    for (const s of ['L', 'R']) {
      const h = spec.hands[s];
      if (!h) continue;
      const d = sub(h, add(chest, mul(shAx, side(s) * B.shoulderHalf)));
      // too far to reach, or nearer than a folded arm lets the hand come
      const ex = len(d) > maxArm ? len(d) - maxArm : len(d) < minArm ? len(d) - minArm : 0;
      if (ex) { push = add(push, mul(unit(d), ex)); n++; }
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

  const { t0, t1, waistC, front, headUp, headC } = trunk(hipC, chestC, lean, shAx);

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

  out.headUp = headUp;
  out.headC = headC;
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

/**
 * The pose a modelled body was made in, from where its joints are:
 *   J.hipL, kneeL, ankleL, toeL, shoulderL, elbowL, wristL, knuckleL (middle
 *   finger), indexL, littleL, and the same with R
 * in the figure's own axes. frames() of the result are the frames the mesh is
 * bound to, so that a solved pose which puts every joint back where the model
 * has it leaves the mesh exactly as it was made.
 */
export function bindPose(J) {
  const half = (a, b) => mul(add(a, b), 0.5);
  const hipC = half(J.hipL, J.hipR), chestC = half(J.shoulderL, J.shoulderR);
  const lean = unit(sub(chestC, hipC));
  const hipAx = unit(sub(J.hipL, J.hipR)), shAx = unit(sub(J.shoulderL, J.shoulderR));
  const { t0, t1, waistC, front, headUp, headC } = trunk(hipC, chestC, lean, shAx);
  const p = { hipC, chestC, waistC, lean, t0, t1, hipAx, shAx, headUp, headC, gaze: unit(perpPart(front, headUp)), L: {}, R: {}, bat: null };
  for (const s of ['L', 'R']) {
    const o = p[s];
    o.hip = J[`hip${s}`]; o.knee = J[`knee${s}`]; o.ankle = J[`ankle${s}`];
    // the plane a limb bends in, as hinge() would report it
    const bend = (from, mid, to, pole) => {
      const n = cross(sub(to, from), sub(mid, from));
      return len(n) > 1e-5 ? unit(n) : unit(cross(sub(to, from), pole));
    };
    o.legN = bend(o.hip, o.knee, o.ankle, [0, 1, 0]);
    const toe = sub(J[`toe${s}`], o.ankle);
    o.footDir = unit([toe[0], toe[1], 0]);
    o.footPos = [o.ankle[0], o.ankle[1]];
    o.shoulder = J[`shoulder${s}`]; o.elbow = J[`elbow${s}`];
    o.hand = half(J[`wrist${s}`], J[`knuckle${s}`]);
    o.armN = bend(o.shoulder, o.elbow, o.hand, [0, -1, 0]);
    // the line a gripped handle would take through the hand, toward the thumb
    o.handHint = unit(sub(J[`index${s}`], J[`little${s}`]));
  }
  return p;
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
export function batterPose(plan, t, clock = 0) {
  const P = plan;
  const front = { pos: [CREASE - 0.24, -0.31], toe: [-0.2, 0.98], lift: 0 };
  const back = { pos: [CREASE + 0.3, -0.31], toe: [0.05, 1], lift: 0 };
  let k = STANCE, sink = 0, weight = 0.5, gazeAt = BOWLERS_HAND;

  if (P) {
    const tc = P.contact, tr = P.release;
    const up = ease((t - tr + 0.16) / 0.26); // backlift as the arm comes over
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

  // Waiting, the batter taps the bat behind the back foot; it stops as the
  // bowler gets near the crease.
  const waiting = P ? 1 - ease((t - P.release + 1.0) / 0.5) : 1;
  let top = k.top.slice();
  if (waiting > 0) top[2] += waiting * 0.035 * Math.max(0, Math.sin(clock * 6.2)) ** 2;
  // the bat never goes through the ground
  const toe = top[2] + k.dir[2] * BAT.length;
  if (toe < 0.012) top[2] += 0.012 - toe;

  const turn = k.turn * D2R, hipTurn = turn * 0.55;
  const spec = {
    hipC: [lerp(back.pos[0], front.pos[0], weight), (front.pos[1] + back.pos[1]) / 2 + 0.04, 0.86 - sink + breath(clock, 0.3).rise],
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

// ------------------------------------------------------------------- on foot
// Nobody stands quite still: the chest rises with each breath and the weight
// drifts from foot to foot. `who` sets each person's own rhythm.
function breath(clock, who = 0) {
  const a = Math.sin(clock * 1.7 + who * 5.1);
  return { rise: 0.004 * a, nod: 0.007 * a, sway: 0.012 * Math.sin(clock * 0.43 + who * 9.7) };
}

// a value keyed in time, eased from one key to the next: keys are [time, value]
function keyed(t, keys, blend = lerp) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) return blend(keys[i - 1][1], keys[i][1], ease((t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0])));
  }
  return keys[keys.length - 1][1];
}
const dirs = (a, b, k) => unit(mix(a, b, k));

// a foot on its way from one footfall to the next, u from 0 to 1
function swingFoot(from, to, u, rise, heel) {
  const e = ease(u);
  return {
    pos: [lerp(from.pos[0], to.pos[0], e), lerp(from.pos[1], to.pos[1], e)],
    toe: [lerp(from.toe[0], to.toe[0], e), lerp(from.toe[1], to.toe[1], e)],
    ground: rise * Math.sin(Math.PI * u) ** 1.2, lift: heel * (1 - u) ** 1.5,
  };
}

const GAITS = {
  walk: { step: 0.5, stance: 0.56, late: 0.03, rise: 0.07, heel: 0.5, top: 1.3, hip: 0.915, bob: 0.012, lean: 0.04, arms: 0.14, bend: 0.06, half: 0.085 },
  run: { step: 0.26, stance: 0.3, late: 0.022, rise: 0.2, heel: 0.95, top: 5.4, hip: 0.89, bob: 0.03, lean: 0.2, arms: 0.27, bend: 0.2, half: 0.07 },
};

/**
 * Someone walking or running. path(t) is where the hips are over the ground.
 * The feet come down a little ahead of the hips at a steady beat, left then
 * right, and stay where they land until they push off behind, so nothing
 * skates. Standing still is
 * the same thing with no speed.
 *   o.gait   'walk' or 'run'
 *   o.beat   the time at which a left foot is squarely under the body
 *   o.face   which way the body faces when it is not moving
 * Returns what solve() needs, plus `go` (0 standing to 1 at full pace).
 */
function onFoot(path, t, o) {
  const G = GAITS[o.gait || 'walk'];
  const P = 2 * G.step, D = G.stance * P, e = 0.02;
  const speedAt = (c) => { const a = path(c - e), b = path(c + e); return [(b[0] - a[0]) / (2 * e), (b[1] - a[1]) / (2 * e)]; };
  const face = unit([o.face[0], o.face[1], 0]);
  const headingAt = (c) => { const v = speedAt(c), m = Math.hypot(v[0], v[1]); return m > 0.15 ? [v[0] / m, v[1] / m] : [face[0], face[1]]; };
  const paceAt = (c) => clamp(Math.hypot(...speedAt(c)) / G.top, 0, 1);
  const plant = (c, side) => {
    // a foot lands a short way ahead and leaves from farther behind
    const h = headingAt(c), at = path(c - G.late), go = paceAt(c);
    const half = lerp(0.115, G.half, go) * (side === 'L' ? 1 : -1);
    return { pos: [at[0] - h[1] * half, at[1] + h[0] * half], toe: h, go };
  };
  const foot = (side) => {
    const off = o.beat + (side === 'L' ? 0 : P / 2);
    const c = off + Math.floor((t - off + D / 2) / P) * P; // this foot's latest landing is centred on c
    const here = plant(c, side);
    if (t <= c + D / 2) {
      const late = Math.max(0, (t - c) / (D / 2));
      return { pos: here.pos, toe: here.toe, ground: 0, lift: G.heel * here.go * late * late };
    }
    const next = plant(c + P, side), go = (here.go + next.go) / 2;
    return swingFoot(here, next, (t - c - D / 2) / (P - D), G.rise * go, G.heel * go);
  };
  const go = paceAt(t), h = headingAt(t), at = path(t);
  const ph = (2 * Math.PI * (t - o.beat)) / P; // 0 with the left foot under the body
  const left = [-h[1], h[0], 0];
  const twist = 0.14 * go * Math.sin(ph);
  const axis = (k) => unit([left[0] + h[0] * k, left[1] + h[1] * k, 0]);
  const hipZ = lerp(0.955, G.hip, go) + G.bob * go * Math.cos(2 * ph);
  const hipC = [at[0], at[1], hipZ];
  const lean = unit([h[0] * G.lean * go, h[1] * G.lean * go, 1]);
  const shAx = axis(twist * 1.3), chest = add(hipC, mul(lean, BODY.spine));
  // arms swing against the legs, and fold up as the pace rises
  const arm = (side) => {
    const sgn = side === 'L' ? 1 : -1, sw = sgn * Math.sin(ph) * go;
    const sh = add(chest, mul(shAx, sgn * BODY.shoulderHalf));
    const reach = BODY.upperArm + BODY.foreArm;
    return [
      sh[0] + h[0] * (G.arms * sw + G.bend * go) + left[0] * sgn * 0.06,
      sh[1] + h[1] * (G.arms * sw + G.bend * go) + left[1] * sgn * 0.06,
      sh[2] - reach * (0.965 - 0.42 * G.bend * go / 0.2 * Math.min(1, go * 1.4)) + 0.1 * go * Math.max(0, sw),
    ];
  };
  return {
    go, heading: h, left,
    spec: {
      hipC, lean, hipAx: axis(-twist), shAx,
      feet: { L: foot('L'), R: foot('R') },
      hands: { L: arm('L'), R: arm('R') },
      poles: {
        kneeL: [h[0], h[1], 0.2], kneeR: [h[0], h[1], 0.2],
        elbowL: [-h[0] + left[0] * 0.3, -h[1] + left[1] * 0.3, -0.25], elbowR: [-h[0] - left[0] * 0.3, -h[1] - left[1] * 0.3, -0.25],
      },
      gazeAt: [at[0] + h[0] * 20, at[1] + h[1] * 20, 1.4],
      handHint: { L: [h[0], h[1], 0], R: [h[0], h[1], 0] },
    },
  };
}

// -------------------------------------------------------------------- fielders
// Ready positions, in the fielder's own frame: facing +y, left side toward -x.
// `walk` is how far they walk in as the bowler runs up.
const READY = {
  keeper: { hip: 0.5, back: -0.14, lean: [0, 0.6, 0.8], feet: 0.27, hands: [0.065, 0.4, 0.4], toe: 0.45, move: 2.7, walk: 0 },
  close: { hip: 0.62, back: -0.14, lean: [0, 0.6, 0.8], feet: 0.3, hands: [0.06, 0.4, 0.53], toe: 0.35, move: 1.0, walk: 0 },
  ring: { hip: 0.85, back: -0.05, lean: [0, 0.34, 0.94], feet: 0.2, hands: [0.14, 0.3, 0.8], toe: 0.2, move: 1.4, walk: 1.2 },
  deep: { hip: 0.925, back: 0, lean: [0, 0.06, 1], feet: 0.13, hands: [0.26, 0.04, 0.87], toe: 0.22, move: 1.4, walk: 1.6 },
};
const RUN_SPEED = 6.2; // a fielder after the ball, m/s

/**
 * A fielder at time t, in their own frame. Time runs from the ball leaving
 * the bowler's hand at 0; before that the bowler is running in.
 *   kind  'keeper' | 'close' | 'ring' | 'deep'
 *   plan  null, or what this fielder does about the ball:
 *         { start, time, point }  take it: it arrives at `point` (own frame)
 *                                 at `time`, having left the bat at `start`
 *         { start, chase: [x, y] } go after it from `start`
 *   see   { clock, who, ball }: wall-clock seconds for breathing, a number of
 *         their own, and where the ball is (own frame) to keep their eyes on
 */
export function fielderPose(kind, plan, t, see = {}) {
  const R = READY[kind] || READY.ring;
  const clock = see.clock || 0, who = see.who || 0, br = breath(clock, who);
  let k = 0, q = null;
  if (plan && plan.point) {
    const t0 = Math.min(Math.max(plan.start + 0.1, plan.time - 0.6), plan.time - 0.05);
    k = ease((t - t0) / Math.max(0.05, plan.time - t0));
    q = plan.point;
  }
  // down into the ready position as the bowler reaches the crease
  const set = ease((t + 1.0) / 0.75);
  const watch = see.ball && t > 0 ? see.ball : [0, 20, 1.2];

  // walking in, then standing; or away after the ball
  const chase = plan && plan.chase && t > plan.start + 0.22 ? plan : null;
  if (chase || (R.walk && set < 1 && !q)) {
    let path, gait = 'walk', face = [0, 1];
    if (chase) {
      const d = Math.hypot(chase.chase[0], chase.chase[1]) || 1, u = [chase.chase[0] / d, chase.chase[1] / d];
      const t0 = chase.start + 0.22;
      // up to speed over half a second, and no farther than the ball
      path = (c) => { const tau = Math.max(0, c - t0), run = Math.min(d - 0.6, RUN_SPEED * (tau < 0.5 ? tau * tau : tau - 0.25)); return [u[0] * Math.max(0, run), u[1] * Math.max(0, run)]; };
      gait = 'run'; face = u;
    } else {
      path = (c) => [0, -R.walk * (1 - ease((c + 2.4) / 1.7))];
    }
    const m = onFoot(path, t, { gait, beat: who * 0.37, face });
    const spec = m.spec;
    spec.gazeAt = watch;
    if (!chase) {
      // settle from the walk into the ready position
      const at = path(t);
      const ready = readySpec(R, kind, [at[0], at[1]], br);
      return solve(blendSpec(spec, ready, set));
    }
    return solve(spec);
  }

  const root = [0, 0];
  const spec = readySpec(R, kind, root, br);
  if (!R.walk && set < 1 && !q) {
    // close catchers and the keeper stand easy until the bowler is nearly in
    const easy = onFoot(() => [0, R.back], t, { gait: 'walk', beat: who * 0.37, face: [0, 1] }).spec;
    easy.hipC[2] += br.rise;
    easy.gazeAt = watch;
    spec.gazeAt = watch;
    return solve(blendSpec(easy, spec, set));
  }
  spec.gazeAt = watch;
  if (q && k > 0) {
    // get the body to where the hands can take it a forearm's length in front
    const d = Math.hypot(q[0], q[1]);
    const go = Math.min(Math.max(0, d - 0.36), R.move) * k;
    if (d > 1e-6) { root[0] = (q[0] / d) * go; root[1] = (q[1] / d) * go; }
    const hip = lerp(R.hip, clamp(q[2] - 0.32, 0.46, 0.925), k);
    spec.hipC = [root[0], root[1] + R.back * (1 - k * 0.6), hip];
    spec.lean = unit(mix(R.lean, [(q[0] - root[0]) * 0.3, 0.12 + (q[1] - root[1]) * 0.2, 0.95], k));
    spec.hands.L = mix(spec.hands.L, [q[0] - 0.045, q[1], q[2]], k);
    spec.hands.R = mix(spec.hands.R, [q[0] + 0.045, q[1], q[2]], k);
    spec.feet.L.pos = [root[0] - R.feet, root[1]];
    spec.feet.R.pos = [root[0] + R.feet, root[1]];
    spec.gazeAt = mix(watch, q, Math.min(1, k * 3));
  }
  return solve(spec);
}

// crouched and waiting, at `root`
function readySpec(R, kind, root, br) {
  const cup = kind === 'deep' ? [0, 1, 0] : [1, 0, 0];
  return {
    hipC: [root[0] + br.sway * 0.5, root[1] + R.back, R.hip + br.rise],
    lean: unit([R.lean[0], R.lean[1] + br.nod, R.lean[2]]), hipAx: [-1, 0, 0], shAx: [-1, 0, 0],
    feet: {
      L: { pos: [root[0] - R.feet, root[1]], toe: [-R.toe, 1] },
      R: { pos: [root[0] + R.feet, root[1]], toe: [R.toe, 1] },
    },
    hands: { L: [root[0] - R.hands[0], root[1] + R.hands[1], R.hands[2] + br.rise], R: [root[0] + R.hands[0], root[1] + R.hands[1], R.hands[2] + br.rise] },
    poles: { kneeL: [-R.toe - 0.15, 1, 0.1], kneeR: [R.toe + 0.15, 1, 0.1], elbowL: [-0.8, -0.5, -0.3], elbowR: [0.8, -0.5, -0.3] },
    gazeAt: [root[0], root[1] + 20, 1.2],
    handHint: { L: cup, R: cup },
  };
}

// part way from one whole-body request to another
function blendSpec(a, b, k) {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const foot = (f, g) => ({
    pos: [lerp(f.pos[0], g.pos[0], k), lerp(f.pos[1], g.pos[1], k)], toe: [lerp(f.toe[0], g.toe[0], k), lerp(f.toe[1], g.toe[1], k)],
    lift: lerp(f.lift || 0, g.lift || 0, k), ground: lerp(f.ground || 0, g.ground || 0, k),
  });
  const out = {
    hipC: mix(a.hipC, b.hipC, k), lean: dirs(a.lean, b.lean, k), hipAx: dirs(a.hipAx, b.hipAx, k), shAx: dirs(a.shAx, b.shAx, k),
    feet: { L: foot(a.feet.L, b.feet.L), R: foot(a.feet.R, b.feet.R) },
    hands: { L: mix(a.hands.L, b.hands.L, k), R: mix(a.hands.R, b.hands.R, k) },
    poles: {}, gazeAt: mix(a.gazeAt, b.gazeAt, k),
    handHint: { L: dirs(a.handHint.L, b.handHint.L, k), R: dirs(a.handHint.R, b.handHint.R, k) },
    bat: b.bat || a.bat || null,
  };
  for (const j of ['kneeL', 'kneeR', 'elbowL', 'elbowR']) out.poles[j] = mix(a.poles[j], b.poles[j], k);
  return out;
}

// ---------------------------------------------------------------------- bowler
/** Seconds from the bowler's first step to the ball leaving the hand. */
export const RUNUP = 2.6;
const HOLD = 0.085; // from the middle of the palm to the middle of a ball held in the fingers
// when, before the ball goes, the bowler leaves the ground, lands the back foot and lands the front
// and how fast the hips travel: at full pace, into the delivery stride, and over the braced front leg
const ACTION = { leap: -0.44, back: -0.25, front: -0.11, pace: 5.4, stride: 4.9, brace: 2.6, turn: Math.PI / 0.17 };
const AT_RELEASE = {
  lean: unit([0.4, 0.2, 0.9]), shAx: unit([0.26, 0.97, -0.62]), arm: unit([0.12, -0.16, 0.98]), hip: 0.93,
};
const STRAIGHT_ARM = BODY.upperArm + BODY.foreArm - 0.016;
// the height this body lets the ball go from when it stands as tall as it is made
const NATURAL_RELEASE = AT_RELEASE.hip + AT_RELEASE.lean[2] * BODY.spine - AT_RELEASE.shAx[2] * BODY.shoulderHalf + AT_RELEASE.arm[2] * (STRAIGHT_ARM + HOLD);

/** How much bigger or smaller than the model a bowler is who lets go at this height. */
export function bowlerScale(releaseHeight) {
  return clamp(releaseHeight / NATURAL_RELEASE, 0.9, 1.16);
}

/** Where a ball held in a hand is. */
export function heldBall(pose, side = 'R') {
  // in the fingers, out along the line of the arm
  const o = pose[side];
  return add(o.hand, mul(unit(sub(o.hand, o.shoulder)), HOLD));
}

/**
 * A right-arm fast bowler, over the wicket, at time t: running in, the leap,
 * back foot and front foot down, the arm coming over, and the follow-through.
 * The ball leaves the hand at t = 0.
 *   release  where the ball is at that moment, in the bowler's own axes: the
 *            pitch's, divided by bowlerScale() of the height
 * The hand holding the ball is on `release` at t = 0, exactly.
 */
export function bowlerPose(release, t, clock = 0) {
  const A = ACTION, B = BODY, Q = AT_RELEASE;
  const br = breath(clock, 0.7);
  // The body at release, worked back from the hand. A release lower than the
  // body's own is a rounder arm; one higher has the bowler off the ground.
  let hipZ = Q.hip + release[2] - NATURAL_RELEASE, arm = Q.arm, air = 0;
  if (hipZ < 0.84) {
    const z = clamp(Q.arm[2] + (hipZ - 0.84) / (STRAIGHT_ARM + HOLD), 0.35, 1), h = Math.sqrt(1 - z * z);
    arm = [0.3 * h, -0.954 * h, z];
    hipZ = 0.84;
  } else if (hipZ > 0.95) { air = hipZ - 0.95; hipZ = 0.95; }
  const shoulder0 = sub(release, mul(arm, STRAIGHT_ARM + HOLD));
  const chest0 = add(shoulder0, mul(Q.shAx, B.shoulderHalf));
  const hip0 = sub(chest0, mul(Q.lean, B.spine));
  hip0[2] = hipZ + air;

  // Over the ground: a standing start, up to pace, into the delivery stride,
  // slowing as the front leg takes the weight, then pulling up and away to
  // the off side.
  const stop = 1.1, wind = 0.7;
  const ran = (tau) => (tau <= 0 ? 0 : A.pace * (tau < wind ? (tau * tau) / (2 * wind) : tau - wind / 2));
  const xFront = hip0[0] + A.brace * A.front;
  const xLeap = xFront + A.stride * (A.leap - A.front);
  const mark = xLeap - ran(RUNUP + A.leap);
  const path = (c) => {
    if (c < A.leap) return [mark + ran(c + RUNUP), hip0[1]];
    if (c < A.front) return [xFront + A.stride * (c - A.front), hip0[1]];
    if (c < 0.1) return [hip0[0] + A.brace * c, hip0[1]];
    const u = Math.min(1, (c - 0.1) / stop);
    return [hip0[0] + A.brace * (0.1 + (stop / 3) * (1 - (1 - u) ** 3)), hip0[1] + 0.85 * ease(u)];
  };

  // ---- the run
  const G = GAITS.run, P = 2 * G.step, D = G.stance * P;
  const run = onFoot(path, Math.min(t, A.leap), { gait: 'run', beat: A.leap - D / 2, face: [1, 0] });
  const spec = run.spec;
  spec.gazeAt = [PITCH.length - PITCH.crease, 0, 1.0];
  if (t < A.leap) {
    spec.hipC[2] += br.rise * (1 - run.go);
    if (run.go < 0.05) { spec.hands.L = null; spec.hands.R = null; }
    return solve(spec);
  }

  // ---- the leap, the delivery stride and the follow-through
  const at = path(t);
  const hipC = [at[0], at[1], keyed(t, [[A.leap, spec.hipC[2]], [(A.leap + A.back) / 2, 1.03], [A.back, 0.87], [A.front, 0.86], [0, hipZ + air], [0.2, 0.86], [0.6, 0.92], [1.0, 0.955]])];
  const lean = keyed(t, [[A.leap, spec.lean], [A.leap + 0.09, unit([0.02, 0, 1])], [A.back, unit([-0.14, -0.04, 1])], [A.front, unit([0.08, 0.1, 1])],
    [0, Q.lean], [0.14, unit([0.8, 0.15, 0.6])], [0.45, unit([0.35, 0.05, 0.93])], [1.0, unit([0.03, 0, 1])]], dirs);
  // side-on at the back foot, then the hips come round ahead of the shoulders
  const yaw = (deg, tilt) => { const a = deg * D2R; return unit([Math.sin(a), Math.cos(a), tilt]); };
  const shAx = keyed(t, [[A.leap, spec.shAx], [A.back, yaw(86, 0.32)], [A.front, yaw(70, 0.12)], [0, Q.shAx], [0.16, yaw(-38, -0.45)], [0.6, yaw(-15, 0)], [1.0, yaw(0, 0)]], dirs);
  const hipAx = keyed(t, [[A.leap, spec.hipAx], [A.back, yaw(72, 0)], [A.front, yaw(30, 0)], [0, yaw(-5, 0)], [0.2, yaw(-30, 0)], [0.7, yaw(-5, 0)], [1.0, yaw(0, 0)]], dirs);
  const chest = add(hipC, mul(lean, B.spine));
  const shR = sub(chest, mul(shAx, B.shoulderHalf)), shL = add(chest, mul(shAx, B.shoulderHalf));

  // Feet. They are in the air at the leap, wherever the run left them. The
  // back foot lands under the body and the front foot well ahead of it; each
  // stays down only while the leg can still reach it.
  const land = (x, y, toe) => ({ pos: [x, y], toe });
  const fromRun = (f, to, u, rise) => {
    const e = ease(u);
    return {
      pos: [lerp(f.pos[0], to.pos[0], e), lerp(f.pos[1], to.pos[1], e)], toe: [lerp(f.toe[0], to.toe[0], e), lerp(f.toe[1], to.toe[1], e)],
      ground: (f.ground || 0) * (1 - e) + rise * Math.sin(Math.PI * u) ** 1.2, lift: (f.lift || 0) * (1 - u) ** 1.5,
    };
  };
  const xBack = path(A.back)[0];
  const backFoot = land(xBack + 0.05, hip0[1] - 0.08, [0.3, -0.95]);
  const frontFoot = land(hip0[0] + 0.12, hip0[1] + 0.05, [1, 0.14]);
  const p20 = path(0.2), p50 = path(0.5), end = path(2);
  const r2 = land(p20[0] + 0.3, p20[1] - 0.1, [1, 0.25]), l2 = land(p50[0] + 0.2, p50[1] + 0.1, [1, 0.3]);
  const r3 = land(end[0] - 0.02, end[1] - 0.115, [1, 0.12]), l3 = land(end[0] + 0.02, end[1] + 0.115, [1, 0.3]);
  const down = (f, lift = 0) => ({ pos: f.pos, toe: f.toe, ground: air * ease(1 - Math.abs(t) / 0.08), lift });
  let L, R;
  if (t < A.front) L = fromRun(spec.feet.L, frontFoot, (t - A.leap) / (A.front - A.leap), 0.34);
  else if (t < 0.24) L = down(frontFoot, 0.5 * ease((t - 0.1) / 0.14));
  else if (t < 0.5) L = swingFoot(frontFoot, l2, (t - 0.24) / 0.26, 0.1, 0.5);
  else if (t < 0.84) L = down(l2, 0.4 * ease((t - 0.72) / 0.12));
  else if (t < 1.1) L = swingFoot(l2, l3, (t - 0.84) / 0.26, 0.07, 0.4);
  else L = down(l3);
  if (t < A.back) R = fromRun(spec.feet.R, backFoot, (t - A.leap) / (A.back - A.leap), 0.06);
  else if (t < -0.16) R = down(backFoot, 0.6 * ease((t - A.back) / (-0.16 - A.back)));
  else if (t < 0.2) R = swingFoot(backFoot, r2, (t + 0.16) / 0.36, 0.09, 0.6);
  else if (t < 0.52) R = down(r2, 0.5 * ease((t - 0.4) / 0.12));
  else if (t < 0.82) R = swingFoot(r2, r3, (t - 0.52) / 0.3, 0.09, 0.5);
  else R = down(r3);

  // the bowling arm: gathered by the chin, down past the hip, back, over, and through
  const fwd = unit(perpPart([1, 0, 0], arm));
  const round = (a) => add(shR, mul(add(mul(arm, Math.cos(a)), mul(fwd, Math.sin(a))), STRAIGHT_ARM));
  const front = unit(cross(shAx, [0, 0, 1]));
  const gather = add(chest, add(mul(front, 0.2), [0, 0, 0.2]));
  const finish = add(hipC, add(mul(hipAx, 0.24), [0.16, 0, 0.02]));
  let handR;
  if (t < -0.17) handR = mix(mix(spec.hands.R, gather, ease((t - A.leap) / 0.1)), round(-Math.PI), ease((t + 0.31) / 0.14));
  else if (t < 0.11) handR = round(A.turn * t);
  else handR = mix(mix(round(A.turn * 0.11), finish, ease((t - 0.11) / 0.16)), add(shR, [0.04, -0.05, -STRAIGHT_ARM * 0.97]), ease((t - 0.5) / 0.45));
  // the front arm: up at the batter, then pulled down into the side
  const handL = keyed(t, [[A.leap, spec.hands.L], [A.leap + 0.1, add(chest, [0.3, 0.1, 0.24])], [A.back, add(shL, [0.3, 0.0, 0.44])], [A.front, add(shL, [0.42, 0.06, 0.1])],
    [0, add(chest, [0.14, 0.3, -0.4])], [0.2, add(hipC, [-0.24, 0.3, 0.16])], [0.6, add(shL, [0, 0.08, -STRAIGHT_ARM * 0.97])], [1.0, add(shL, [0, 0.06, -STRAIGHT_ARM * 0.97])]], mix);

  const after = ease((t - 0.15) / 0.3);
  return solve({
    hipC, lean, hipAx, shAx,
    feet: { L, R },
    hands: { L: handL, R: handR },
    poles: {
      kneeL: [L.toe[0], L.toe[1], 0.25], kneeR: [R.toe[0], R.toe[1], 0.25],
      elbowL: mix([0.2, 0.6, -0.8], [-0.6, 0.5, -0.4], after), elbowR: mix([0.1, -0.7, -0.7], [-0.7, -0.5, -0.3], after),
    },
    gazeAt: [PITCH.length - PITCH.crease, 0, 1.0],
    handHint: { L: [1, 0, 0], R: [0, 1, 0] },
  });
}

// ------------------------------------------------------------------ the others
/**
 * The batter at the bowler's end: bat grounded behind the crease, then
 * backing up a few steps as the ball is bowled.
 */
export function nonStrikerPose(t, clock = 0) {
  const x0 = PITCH.crease - 0.3, y0 = -1.25;
  const path = (c) => [x0 + 1.1 * ease((c + 0.25) / 1.3), y0];
  const m = onFoot(path, t, { gait: 'walk', beat: 0.1, face: [1, 0] });
  const spec = m.spec, br = breath(clock, 1.9);
  spec.hipC[2] += br.rise * (1 - m.go);
  // the bat trails from the right hand, its toe on the ground
  const dir = unit([-0.5, 0.05, -0.86]);
  const sh = sub(add(spec.hipC, mul(spec.lean, BODY.spine)), mul(spec.shAx, BODY.shoulderHalf));
  const top = [sh[0] - 0.1, sh[1] - 0.08, BAT.length * 0.86 + 0.012 - dir[2] * 0 + 0.05 * m.go];
  spec.hands.R = add(top, mul(dir, BAT.topHand + 0.04));
  spec.hands.L = m.go < 0.05 ? null : spec.hands.L;
  spec.handHint.R = dir;
  spec.gazeAt = t < 0 ? [x0 - 6, 0.6, 1.6] : [PITCH.length - PITCH.crease, 0, 1.0];
  spec.bat = { top, dir };
  return solve(spec);
}

/** An umpire, in their own frame like a fielder: standing, hands behind the back. */
export function umpirePose(t, see = {}) {
  const clock = see.clock || 0, who = see.who || 0, br = breath(clock, who);
  const m = onFoot(() => [br.sway, 0], 0, { gait: 'walk', beat: 0, face: [0, 1] });
  const spec = m.spec;
  spec.hipC[2] += br.rise;
  spec.lean = unit([0, 0.03 + br.nod, 1]);
  spec.hands = { L: [-0.07, -0.16, spec.hipC[2] + 0.02], R: [0.07, -0.16, spec.hipC[2] + 0.02] };
  spec.poles.elbowL = [-1, -0.6, 0]; spec.poles.elbowR = [1, -0.6, 0];
  spec.gazeAt = see.ball && t > 0 ? see.ball : [0, 20, 1.0];
  return solve(spec);
}

export const _vec = { add, sub, mul, dot, len, unit, mix, cross, clamp, lerp, ease };
