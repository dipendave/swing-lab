// The figures: bones that never stretch, hands that stay on the bat, feet on
// the ground, and a bat that is where the ball is when the two meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, DEFAULTS, PITCH } from '../src/physics.js';
import { faceBall, SHOTS } from '../src/batter.js';
import { mulberry32 } from '../src/challenge.js';
import { BODY, BAT, BONES, RUNUP, batterPose, fielderPose, bowlerPose, bowlerScale, heldBall, nonStrikerPose, umpirePose, restPose, frames, swing } from '../src/pose.js';

const CREASE = PITCH.length - PITCH.crease;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];

// every stroke, at every sensible and some silly places to meet the ball
function* everyStroke() {
  for (const [shot, spec] of Object.entries(SHOTS)) {
    for (const plane of [CREASE - 1.2, CREASE - 0.6, CREASE - 0.1, CREASE + 0.15]) {
      for (const y of [-0.5, -0.1, 0.3, 0.85]) {
        for (const z of [0.06, 0.5, 1.0, 1.75]) {
          yield { release: 0, contact: 0.48, plane, shot, kind: spec.bat, attack: spec.attack, bat: { y, z } };
        }
      }
    }
  }
}

// the strokes the batter model really plays, against a spread of deliveries
function realPlans(n = 150) {
  const rng = mulberry32(11);
  const plans = [];
  for (let i = 0; i < n; i++) {
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.delivery.speedKmh = 100 + Math.floor(rng() * 55);
    cfg.delivery.length = rng() * 13;
    cfg.delivery.line = -40 + rng() * 100;
    cfg.seam.angle = Math.round(-30 + rng() * 60);
    cfg.seed = i + 1;
    const sim = simulate(cfg);
    const o = faceBall(sim, cfg, { need: 9, ballsLeft: 6, wicketsLeft: 3, field: i % 2 ? 'slips' : 'spread' }, rng);
    if (!o.contact) continue;
    const spec = SHOTS[o.shot] || SHOTS.leave;
    plans.push({
      release: 0, contact: o.contact.t, plane: o.contact.p[0], shot: o.shot, kind: spec.bat, attack: spec.attack,
      bat: o.bat || { y: o.contact.p[1], z: o.contact.p[2] }, ball: o.contact.p, touched: o.quality !== 'miss' && o.quality !== 'none',
    });
  }
  return plans;
}

function checkBody(p, label) {
  for (const s of ['L', 'R']) {
    const o = p[s];
    assert.ok(Math.abs(dist(o.shoulder, o.elbow) - BODY.upperArm) < 1e-9, `${label}: upper arm keeps its length`);
    assert.ok(Math.abs(dist(o.elbow, o.hand) - BODY.foreArm) < 1e-9, `${label}: forearm keeps its length`);
    assert.ok(Math.abs(dist(o.hip, o.knee) - BODY.thigh) < 1e-9, `${label}: thigh keeps its length`);
    assert.ok(Math.abs(dist(o.knee, o.ankle) - BODY.shin) < 1e-9, `${label}: shin keeps its length`);
    assert.ok(o.ankle[2] >= BODY.ankle - 1e-9, `${label}: foot on or above the ground`);
    assert.ok(o.knee[2] > 0 && o.elbow[2] > 0 && o.hand[2] > 0, `${label}: nothing below the ground`);
  }
  assert.ok(Math.abs(dist(p.hipC, p.chestC) - BODY.spine) < 1e-9, `${label}: spine keeps its length`);
  assert.ok(p.headC[2] > p.hipC[2], `${label}: head above the hips`);
}

test('rest pose: upright, symmetric, about 1.8 m tall', () => {
  const p = restPose();
  assert.ok(Math.abs(p.L.hand[0] + p.R.hand[0]) < 1e-9 && Math.abs(p.L.hand[2] - p.R.hand[2]) < 1e-9);
  assert.ok(Math.abs(p.L.knee[0] + p.R.knee[0]) < 1e-9);
  const top = p.headC[2] + 0.118;
  assert.ok(top > 1.74 && top < 1.88, `stands ${top.toFixed(2)} m`);
  checkBody(p, 'rest');
});

test('frames: one per bone, each a right-handed set of unit axes', () => {
  const poses = [restPose(), batterPose(null, 0), fielderPose('keeper', null, 0), fielderPose('deep', null, 0)];
  for (const plan of everyStroke()) for (const t of [0.2, 0.4, 0.48, 0.6, 0.9]) poses.push(batterPose(plan, t));
  for (const p of poses) {
    const fs = frames(p);
    assert.equal(fs.length, BONES.length);
    for (const f of fs) {
      for (const v of [f.o, f.x, f.y, f.z]) for (const c of v) assert.ok(Number.isFinite(c));
      for (const v of [f.x, f.y, f.z]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
      assert.ok(Math.abs(dot(f.x, f.y)) < 1e-6 && Math.abs(dot(f.y, f.z)) < 1e-6 && Math.abs(dot(f.x, f.z)) < 1e-6);
      assert.ok(dist(cross(f.x, f.y), f.z) < 1e-6, 'right-handed');
    }
  }
});

test('batter: no bone ever stretches and nothing sinks into the ground, whatever the stroke', () => {
  for (const plan of everyStroke()) {
    for (let t = 0; t <= 1.0; t += 0.04) {
      const p = batterPose(plan, t);
      checkBody(p, `${plan.shot} at ${t.toFixed(2)}`);
      const toe = along(p.bat.top, p.bat.dir, BAT.length);
      assert.ok(toe[2] > 0, `${plan.shot}: the bat stays above the ground`);
    }
  }
});

test('batter: stands still in the stance until the bowler is in the delivery stride', () => {
  const plan = { release: 0, contact: 0.5, plane: CREASE - 0.5, shot: 'drive', kind: 'vertical', attack: true, bat: { y: 0.1, z: 0.4 } };
  const idle = batterPose(null, 0), start = batterPose(plan, -0.3);
  assert.ok(dist(idle.L.hand, start.L.hand) < 1e-9 && dist(idle.headC, start.headC) < 1e-9);
  // by release the bat is on its way up
  assert.ok(batterPose(plan, 0).L.hand[2] > idle.L.hand[2] + 0.03);
  // waiting, the bat taps the ground but never goes into it
  for (let clock = 0; clock < 3; clock += 0.05) {
    const p = batterPose(plan, -2, clock);
    assert.ok(along(p.bat.top, p.bat.dir, BAT.length)[2] > 0);
    assert.ok(dist(p.L.hand, along(p.bat.top, p.bat.dir, BAT.topHand)) < 0.03);
  }
  // bat grounded by the back foot, front shoulder toward the bowler
  const toe = along(idle.bat.top, idle.bat.dir, BAT.length);
  assert.ok(toe[2] < 0.03 && toe[0] > CREASE);
  assert.ok(idle.L.shoulder[0] < idle.R.shoulder[0]);
});

test('batter: for the strokes really played, both hands stay on the handle', () => {
  let worst = 0;
  for (const plan of realPlans()) {
    for (let t = 0; t <= plan.contact + 0.5; t += 0.02) {
      const p = batterPose(plan, t);
      worst = Math.max(worst,
        dist(p.L.hand, along(p.bat.top, p.bat.dir, BAT.topHand)),
        dist(p.R.hand, along(p.bat.top, p.bat.dir, BAT.bottomHand)));
    }
  }
  assert.ok(worst < 0.06, `a hand came ${(worst * 100).toFixed(1)} cm off the handle`);
});

test('batter: when bat meets ball, the blade is where the ball is', () => {
  let checked = 0, worstGap = 0;
  for (const plan of realPlans()) {
    if (!plan.touched || plan.kind === 'none') continue;
    const p = batterPose(plan, plan.contact);
    // nearest point of the blade's centre line (below the handle) to the ball
    const rel = [plan.ball[0] - p.bat.top[0], plan.ball[1] - p.bat.top[1], plan.ball[2] - p.bat.top[2]];
    const s = Math.min(BAT.length, Math.max(0.3, dot(rel, p.bat.dir)));
    const gap = dist(plan.ball, along(p.bat.top, p.bat.dir, s));
    // an edge is by definition up to a blade's half-width and a ball away from the middle
    worstGap = Math.max(worstGap, gap);
    assert.ok(gap < 0.12, `${plan.shot}: ball ${(gap * 100).toFixed(0)} cm from the blade`);
    checked++;
  }

  assert.ok(checked > 40);
});

test('batter: goes forward to a full ball and back to a short one', () => {
  const at = (plane, shot, kind) => batterPose({ release: 0, contact: 0.5, plane, shot, kind, attack: true, bat: { y: 0.1, z: kind === 'vertical' ? 0.4 : 1.2 } }, 0.5);
  const stance = batterPose(null, 0);
  const drive = at(CREASE - 0.8, 'drive', 'vertical'), pull = at(CREASE + 0.1, 'pull', 'horizontal');
  assert.ok(drive.L.footPos[0] < stance.L.footPos[0] - 0.3, 'front foot strides toward the bowler');
  assert.ok(pull.R.footPos[0] > stance.R.footPos[0] + 0.2, 'back foot goes back');
  assert.ok(pull.R.footPos[0] < PITCH.length - 0.2, 'but not onto the stumps');
});

test('fielders: ready positions are sound, the keeper lowest and the outfielders upright', () => {
  const kinds = ['keeper', 'close', 'ring', 'deep'];
  const poses = kinds.map((k) => fielderPose(k, null, 0));
  poses.forEach((p, i) => checkBody(p, kinds[i]));
  for (let i = 1; i < poses.length; i++) assert.ok(poses[i].headC[2] > poses[i - 1].headC[2], `${kinds[i]} stands taller than ${kinds[i - 1]}`);
  assert.ok(poses[3].headC[2] > 1.6);
});

test('fielders: the hands are on the ball when it arrives', () => {
  const cases = [
    ['keeper', [0.4, 0.4, 0.6]], ['keeper', [-2.2, 0.4, 1.5]], ['keeper', [1.5, 0.4, 0.35]],
    ['close', [0, 0.4, 0.7]], ['close', [0.3, 0.4, 1.3]], ['deep', [0, 0, 1.5]], ['ring', [0, 0, 1.5]],
  ];
  for (const [kind, point] of cases) {
    const plan = { start: 0.5, time: 1.2, point };
    for (let t = 0; t <= 1.2; t += 0.05) checkBody(fielderPose(kind, plan, t), `${kind} going for it`);
    const p = fielderPose(kind, plan, 1.2);
    const mid = [(p.L.hand[0] + p.R.hand[0]) / 2, (p.L.hand[1] + p.R.hand[1]) / 2, (p.L.hand[2] + p.R.hand[2]) / 2];
    assert.ok(dist(mid, point) < 0.03, `${kind}: hands ${(dist(mid, point) * 100).toFixed(1)} cm from the ball at ${point}`);
    // and they have not moved before the ball was played
    const before = fielderPose(kind, plan, 0.4), ready = fielderPose(kind, null, 0);
    assert.ok(dist(before.L.hand, ready.L.hand) < 1e-9);
  }
});

test('swing: turns one direction into another along the shortest way round', () => {
  const a = [1, 0, 0], b = [0, 1, 0];
  const h = swing(a, b, 0.5);
  assert.ok(Math.abs(h[0] - Math.SQRT1_2) < 1e-9 && Math.abs(h[1] - Math.SQRT1_2) < 1e-9);
  assert.ok(dist(swing(a, b, 1), b) < 1e-9 && dist(swing(a, b, 0), a) < 1e-9);
  const back = swing(a, [-1, 0, 0], 0.5); // opposite directions: any way round, but still a unit vector
  assert.ok(Math.abs(Math.hypot(...back) - 1) < 1e-9);
});

// ------------------------------------------------------------------ the bowler
const HEIGHTS = [1.7, 1.85, 2.0, 2.15, 2.3, 2.5];
const releaseFor = (h, y = 0.45) => { const s = bowlerScale(h); return { s, rel: [PITCH.crease / s, y / s, h / s] }; };

test('bowler: the ball is in the hand until it is where the flight starts, at every release height', () => {
  for (const h of HEIGHTS) {
    for (const y of [0.3, 0.45, 0.6]) {
      const { s, rel } = releaseFor(h, y);
      const p = bowlerPose(rel, 0);
      const miss = dist(heldBall(p).map((x) => x * s), [PITCH.crease, y, h]);
      assert.ok(miss < 0.002, `release ${h} m: ball ${(miss * 1000).toFixed(1)} mm from where its flight starts`);
      // a straight arm, as the law asks
      assert.ok(dist(p.R.shoulder, p.R.hand) > BODY.upperArm + BODY.foreArm - 0.02, 'the arm is straight at release');
      // and a legal delivery: some part of the front foot behind the popping crease
      assert.ok((p.L.footPos[0] - 0.07) * s < PITCH.crease, 'the front foot is not over the line');
    }
  }
  assert.ok(bowlerScale(1.7) >= 0.9 && bowlerScale(2.5) <= 1.16 && Math.abs(bowlerScale(2.12) - 1) < 0.01);
});

test('bowler: sound from the mark to the end of the follow-through, feet planted, nothing sudden', () => {
  for (const h of HEIGHTS) {
    const { rel } = releaseFor(h);
    let prev = null;
    const dt = 0.005;
    for (let t = -RUNUP - 0.3; t <= 1.5; t += dt) {
      const p = bowlerPose(rel, t, t + 7);
      checkBody(p, `bowler ${h} at ${t.toFixed(3)}`);
      if (prev) {
        for (const sd of ['L', 'R']) {
          const a = prev[sd].ankle, b = p[sd].ankle;
          // a foot that is down stays where it is
          if (a[2] < BODY.ankle + 0.004 && b[2] < BODY.ankle + 0.004) {
            assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) / dt < 0.6, `bowler ${h}: ${sd} foot slides at ${t.toFixed(3)}`);
          }
          assert.ok(dist(a, b) / dt < 14, `bowler ${h}: ${sd} foot jumps at ${t.toFixed(3)}`);
          assert.ok(dist(prev[sd].hand, p[sd].hand) / dt < 26, `bowler ${h}: ${sd} hand jumps at ${t.toFixed(3)}`);
        }
        assert.ok(dist(prev.hipC, p.hipC) / dt < 7, `bowler ${h}: hips jump at ${t.toFixed(3)}`);
      }
      prev = p;
    }
  }
});

test('bowler: runs in from a mark, lets go at the crease, and pulls up off the pitch', () => {
  const { s, rel } = releaseFor(2.15);
  const mark = bowlerPose(rel, -RUNUP - 1), still = bowlerPose(rel, -RUNUP - 2), end = bowlerPose(rel, 1.5), later = bowlerPose(rel, 3);
  assert.ok(dist(mark.hipC, still.hipC) < 1e-9, 'stands at the mark before the run');
  assert.ok(mark.hipC[0] * s < -8 && mark.hipC[0] * s > -16, `the mark is ${(-mark.hipC[0] * s).toFixed(1)} m back`);
  assert.ok(dist(end.hipC, later.hipC) < 1e-6, 'comes to a stop');
  assert.ok(end.hipC[0] * s < PITCH.crease + 3 && end.hipC[1] * s > 1.2, 'ends off the pitch, to the off side');
  // side-on when the back foot lands, front arm up
  const back = bowlerPose(rel, -0.25);
  assert.ok(back.L.shoulder[0] > back.R.shoulder[0] + 0.25, 'front shoulder toward the batter');
  assert.ok(back.L.hand[2] > back.L.shoulder[2], 'front arm up');
  // the arm comes over the top: behind and below the shoulder, then above it
  const coming = bowlerPose(rel, -0.085);
  assert.ok(coming.R.hand[0] < coming.R.shoulder[0] - 0.4);
  assert.ok(bowlerPose(rel, 0).R.hand[2] > bowlerPose(rel, 0).headC[2]);
});

// ------------------------------------------------------------- everyone else
test('fielders: walk in, stand ready, watch the ball and run after it without a bone out of place', () => {
  for (const kind of ['keeper', 'close', 'ring', 'deep']) {
    for (let t = -3; t <= 3; t += 0.01) {
      checkBody(fielderPose(kind, null, t, { clock: t + 5, who: 0.3 }), `${kind} waiting at ${t.toFixed(2)}`);
      checkBody(fielderPose(kind, { start: 0.5, chase: [6, 9] }, t, { clock: t, who: 0.8, ball: [3, 3, 1] }), `${kind} chasing at ${t.toFixed(2)}`);
    }
  }
  // outfielders start farther back and are in position when the ball is bowled
  const early = fielderPose('deep', null, -2.5), set = fielderPose('deep', null, 0);
  assert.ok(early.hipC[1] < set.hipC[1] - 1, 'walks in');
  // the chase covers ground toward the ball and stops short of it
  const plan = { start: 0.5, chase: [6, 9] };
  const a = fielderPose('ring', plan, 1.2), b = fielderPose('ring', plan, 2.2), c = fielderPose('ring', plan, 9);
  const to = (p) => Math.hypot(6 - p.hipC[0], 9 - p.hipC[1]);
  assert.ok(to(b) < to(a) - 3 && to(c) < 1 && to(c) > 0.3);
  // eyes follow the ball
  const left = fielderPose('ring', null, 1, { ball: [-8, 4, 1] }), right = fielderPose('ring', null, 1, { ball: [8, 4, 1] });
  assert.ok(left.gaze[0] < -0.3 && right.gaze[0] > 0.3);
});

test('non-striker and umpires: sound, the non-striker backing up with the bat grounded behind', () => {
  for (let t = -3; t <= 3; t += 0.01) {
    const n = nonStrikerPose(t, t);
    checkBody(n, `non-striker at ${t.toFixed(2)}`);
    assert.ok(along(n.bat.top, n.bat.dir, BAT.length)[2] > 0, 'bat above the ground');
    assert.ok(dist(n.R.hand, along(n.bat.top, n.bat.dir, BAT.topHand + 0.04)) < 0.03, 'bat in the hand');
    checkBody(umpirePose(t, { clock: t, who: 3.3 }), `umpire at ${t.toFixed(2)}`);
  }
  const before = nonStrikerPose(-1), after = nonStrikerPose(2);
  assert.ok(before.hipC[0] < PITCH.crease && after.hipC[0] > before.hipC[0] + 0.8, 'leaves the crease as the ball is bowled');
  assert.ok(before.hipC[1] < -0.9, 'stands clear of the pitch, away from the bowler');
});
