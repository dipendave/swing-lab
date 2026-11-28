// The batter, the rules of the over and the flight after the bat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, expectedPath, DEFAULTS, PITCH, BALL } from '../src/physics.js';
import { faceBall, aggression, atPlane, atTime, RULES, SHOTS } from '../src/batter.js';
import { SCENARIOS, applyScenario, newOver, situation, recordBall, standing, deliver, mulberry32 } from '../src/challenge.js';
import { FIELDS, catcher, flightAfter } from '../src/field.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const cfgWith = (fn) => { const c = clone(DEFAULTS); fn(c); return c; };
const ctx = (o = {}) => ({ need: 9, ballsLeft: 6, wicketsLeft: 3, field: 'slips', ...o });
const S = PITCH.length, CREASE = S - PITCH.crease;

// play the same ball many times against fresh batters
function many(cfg, context, n = 300, seed = 1) {
  const sim = simulate(cfg);
  const rng = mulberry32(seed);
  const tally = { runs: 0, wickets: 0, how: {}, shot: {}, quality: {}, n };
  for (let i = 0; i < n; i++) {
    const o = faceBall(sim, cfg, context, rng);
    tally.runs += o.result.runs;
    if (o.result.wicket) tally.wickets++;
    tally.how[o.result.how] = (tally.how[o.result.how] || 0) + 1;
    tally.shot[o.shot] = (tally.shot[o.shot] || 0) + 1;
    tally.quality[o.quality] = (tally.quality[o.quality] || 0) + 1;
  }
  return tally;
}

// ------------------------------------------------------------------ physics hook
test('expected path: with no side force or seam help it matches the reference delivery', () => {
  const cfg = cfgWith((c) => { c.seam.angle = 0; c.pitch.wear = 0; });
  const sim = simulate(cfg);
  const e = expectedPath(cfg, sim.main.samples[0]);
  assert.ok(Math.abs(e.stumps.y - sim.ref.stumps.y) < 1e-6);
  assert.ok(Math.abs(e.stumps.z - sim.ref.stumps.z) < 1e-6);
});

test('expected path: an outswinger ends up further to the off side than a watcher who stops looking expects', () => {
  const cfg = cfgWith((c) => { c.delivery.speedKmh = 118; });
  const sim = simulate(cfg);
  const seen = atTime(sim.main.samples, 0.25);
  const e = expectedPath(cfg, seen);
  const plane = CREASE - 1;
  assert.ok(atPlane(sim.main.samples, plane).p[1] > atPlane(e.samples, plane).p[1] + 0.02);
});

// --------------------------------------------------------------------- the batter
test('batter: same ball, same seed, same result', () => {
  const sim = simulate(DEFAULTS);
  const a = faceBall(sim, DEFAULTS, ctx(), mulberry32(5));
  const b = faceBall(sim, DEFAULTS, ctx(), mulberry32(5));
  assert.deepEqual(a.result, b.result);
  assert.equal(a.shot, b.shot);
});

test('batter: every outcome is well formed', () => {
  const rng = mulberry32(11);
  for (let i = 0; i < 400; i++) {
    const cfg = cfgWith((c) => {
      c.delivery.speedKmh = 70 + Math.floor(rng() * 85); c.delivery.length = rng() * 14; c.delivery.line = -60 + rng() * 140;
      c.seam.angle = -40 + rng() * 80; c.seam.wobble = rng() < 0.5 ? 0 : rng() * 90;
      c.ball = { wearOff: rng() * 100, wearLeg: rng() * 100 }; c.pitch.wear = rng() * 100; c.seed = i + 1;
    });
    const sim = simulate(cfg);
    const o = faceBall(sim, cfg, ctx({ field: i % 2 ? 'slips' : 'spread', need: 1 + Math.floor(rng() * 14) }), rng);
    assert.ok(Number.isInteger(o.result.runs) && o.result.runs >= 0 && o.result.runs <= 7, `runs ${o.result.runs}`);
    assert.ok(o.shot in SHOTS, `shot ${o.shot}`);
    assert.ok(o.text.headline && typeof o.text.detail === 'string' && o.text.why, 'has wording');
    assert.ok(o.contact && o.contact.p.every(Number.isFinite), 'has a contact point');
    if (o.result.wicket) assert.equal(o.result.runs, 0, 'no runs off a wicket ball');
    if (o.result.wicket) assert.ok(o.legal, 'no dismissal off a wide or no-ball');
    if (!o.legal) assert.ok(o.extra === 'wide' || o.extra === 'noball');
    if (o.extra === 'wide') assert.equal(o.result.runs, 1);
    if (o.extra === 'noball') assert.ok(o.result.runs >= 2, 'a no-ball costs one plus what is hit');
    assert.ok(o.text.detail.length <= 34, `detail fits its line: "${o.text.detail}"`);
    assert.ok(o.text.why.length <= 42, `reason fits its line: "${o.text.why}"`);
  }
});

test('batter: a ball beyond the wide line is called wide and costs one run', () => {
  const cfg = cfgWith((c) => { c.delivery.line = 80; c.delivery.releaseY = 1.1; c.seam.angle = 30; c.delivery.speedKmh = 115; });
  const sim = simulate(cfg);
  assert.ok(sim.main.crease.y > RULES.wideOff, `crease y ${sim.main.crease.y}`);
  const t = many(cfg, ctx(), 100);
  assert.equal(t.how.wide, 100);
  assert.equal(t.runs, 100);
  assert.equal(t.wickets, 0);
});

test('batter: a bouncer over head height is a wide', () => {
  // dig it in shorter and shorter until it clears the batter's head
  let cfg, sim;
  for (let length = 11; length <= 14; length += 0.25) {
    cfg = cfgWith((c) => { c.delivery.length = length; c.delivery.speedKmh = 150; c.delivery.line = 0; c.pitch.hardness = 100; });
    sim = simulate(cfg);
    if (sim.main.crease && sim.main.crease.z > RULES.headHigh) break;
  }
  assert.ok(sim.main.crease.z > RULES.headHigh, `height ${sim.main.crease.z}`);
  const o = faceBall(sim, cfg, ctx(), mulberry32(1));
  assert.equal(o.extra, 'wide');
  assert.equal(o.legal, false);
  assert.equal(o.result.runs, 1);
});

test('batter: a ball that bounces twice before the batter is a no-ball and cannot take a wicket', () => {
  const cfg = cfgWith((c) => { c.delivery.length = 14; c.delivery.speedKmh = 60; c.delivery.line = 0; c.pitch = { hardness: 0, grass: 0, moisture: 100, wear: 0 }; c.seam.spin = 0; });
  const sim = simulate(cfg);
  assert.ok(sim.main.bounces.filter((b) => b.p[0] < CREASE).length >= 2, 'it does bounce twice');
  const t = many(cfg, ctx(), 100);
  assert.equal(t.how.noball, 100);
  assert.equal(t.wickets, 0);
  assert.ok(t.runs >= 200, 'one for the no-ball plus whatever is hit');
});

test('batter: a low full toss is a legal ball', () => {
  const cfg = cfgWith((c) => { c.delivery.length = 0; c.delivery.speedKmh = 135; c.delivery.line = 5; });
  const sim = simulate(cfg);
  assert.equal(sim.main.bounces.filter((b) => b.p[0] < CREASE).length, 0, 'reaches the batter on the full');
  assert.ok(sim.main.crease.z < RULES.waistHigh);
  const t = many(cfg, ctx(), 100);
  assert.equal(t.how.noball || 0, 0);
});

test('batter: yorkers are legal balls, never mistaken for no-balls', () => {
  for (let length = 0.4; length <= 1.8; length += 0.05) {
    const cfg = cfgWith((c) => { c.delivery.length = length; c.delivery.speedKmh = 140; c.delivery.line = 5; c.seam.angle = 0; });
    const o = faceBall(simulate(cfg), cfg, ctx(), mulberry32(3));
    assert.notEqual(o.extra, 'noball', `length ${length.toFixed(2)}`);
  }
});

test('batter: late movement is what beats the bat', () => {
  // two balls arriving on the same line: one swings there late, one goes straight
  // pitched up, where there is no time to adjust after it lands
  const base = (c) => { c.delivery.speedKmh = 122; c.delivery.length = 3.6; c.pitch = { hardness: 70, grass: 0, moisture: 0, wear: 0 }; };
  // aim each so that it passes the batter about 8 cm outside middle stump
  const aimed = (angle) => {
    let best = null;
    for (let line = -45; line <= 45; line += 3) {
      const cfg = cfgWith((c) => { base(c); c.seam.angle = angle; c.delivery.line = line; });
      const miss = Math.abs(simulate(cfg).main.crease.y - 0.08);
      if (!best || miss < best.miss) best = { cfg, miss };
    }
    return best.cfg;
  };
  const swinging = aimed(20), straight = aimed(0);
  const ya = simulate(swinging).main.crease.y, yb = simulate(straight).main.crease.y;
  assert.ok(Math.abs(ya - yb) < 0.12 && Math.abs(ya) < 0.25, `both arrive near the stumps (${ya.toFixed(2)}, ${yb.toFixed(2)})`);
  const blocker = ctx({ aggression: 0.06, need: Infinity });
  const beaten = (t) => Object.entries(t.quality).filter(([q]) => q.endsWith('edge') || q === 'miss').reduce((n, [, v]) => n + v, 0);
  const a = many(swinging, blocker, 600), b = many(straight, blocker, 600);
  assert.ok(beaten(a) > 2 * beaten(b) + 20, `swinging beats the bat ${beaten(a)} times in 600, straight ${beaten(b)}`);
  assert.ok(a.wickets > b.wickets, `and takes more wickets: ${a.wickets} vs ${b.wickets}`);
});

test('batter: an outswinger finds the outside edge, an inswinger the inside edge', () => {
  const blocker = ctx({ aggression: 0.06, need: Infinity });
  const away = many(cfgWith((c) => { c.delivery.speedKmh = 120; c.seam.angle = 22; c.delivery.line = 0; c.delivery.length = 6; }), blocker, 500);
  const inn = many(cfgWith((c) => { c.delivery.speedKmh = 120; c.seam.angle = -22; c.delivery.line = 30; c.delivery.length = 6; }), blocker, 500);
  const out = (t) => t.quality['outside-edge'] || 0, ins = (t) => t.quality['inside-edge'] || 0;
  assert.ok(out(away) > 3 * ins(away), `outswinger: ${out(away)} outside, ${ins(away)} inside`);
  assert.ok(ins(inn) > 3 * out(inn), `inswinger: ${ins(inn)} inside, ${out(inn)} outside`);
});

test('batter: half-volleys get hit, good-length balls do not', () => {
  const chasing = ctx({ need: 9, ballsLeft: 6, field: 'spread' });
  const good = many(cfgWith((c) => { c.delivery.length = 6.5; c.delivery.line = 12; }), chasing, 500);
  const halfVolley = many(cfgWith((c) => { c.delivery.length = 3.8; c.delivery.line = 12; c.seam.angle = 0; }), chasing, 500);
  assert.ok(halfVolley.runs > 1.4 * good.runs, `half-volley ${halfVolley.runs} vs good length ${good.runs} runs in 500`);
});

test('batter: a batter who needs runs attacks more than one saving a match', () => {
  const cfg = cfgWith((c) => { c.delivery.length = 6.5; c.delivery.line = 10; });
  const attacking = (t) => Object.entries(t.shot).filter(([s]) => SHOTS[s].attack).reduce((a, [, n]) => a + n, 0);
  const slogger = many(cfg, ctx({ need: 14, ballsLeft: 3 }), 300);
  const blocker = many(cfg, ctx({ aggression: 0.06 }), 300);
  assert.ok(attacking(slogger) > 200, `needing 14 off 3: ${attacking(slogger)} attacking shots in 300`);
  assert.ok(attacking(blocker) < 30, `blocking: ${attacking(blocker)} attacking shots in 300`);
});

test('aggression rises with the required rate and is cautious with the last wicket', () => {
  assert.ok(aggression(ctx({ need: 12, ballsLeft: 3 })) > aggression(ctx({ need: 6, ballsLeft: 6 })));
  assert.ok(aggression(ctx({ need: 6, ballsLeft: 6, wicketsLeft: 1 })) < aggression(ctx({ need: 6, ballsLeft: 6, wicketsLeft: 3 })));
  assert.equal(aggression(ctx({ aggression: 0.06 })), 0.06);
  const a = aggression(ctx({ need: 50, ballsLeft: 1 }));
  assert.ok(a <= 1 && a >= 0.9);
});

test('leg before wicket follows Law 36', () => {
  // full, straight and swinging in: the balls that hit pads. Each is faced many times.
  const rng = mulberry32(21);
  let lbw = 0, notOut = 0;
  // (an old ball at 146 km/h with the seam angled to off reverses in sharply)
  const old = { wearOff: 88, wearLeg: 28 }, fresh = { wearOff: 0, wearLeg: 0 };
  for (const line of [-30, -15, 0, 15, 30, 45, 60]) {
    for (const [angle, speed, length, ball] of [[-25, 128, 4.6, fresh], [20, 146, 4.2, old], [20, 146, 2.6, old], [20, 146, 1.6, old]]) {
      for (const releaseY of [-0.8, 0.55]) {
        const cfg = cfgWith((c) => { c.delivery.speedKmh = speed; c.delivery.length = length; c.delivery.line = line; c.delivery.releaseY = releaseY; c.seam.angle = angle; c.ball = ball; });
        const sim = simulate(cfg);
        const first = sim.main.bounces[0];
        for (let i = 0; i < 120; i++) {
          const o = faceBall(sim, cfg, ctx({ aggression: 0.06, need: Infinity }), rng);
          if (o.result.how === 'lbw') {
            lbw++;
            assert.equal(o.result.wicket, 'lbw');
            assert.ok(sim.main.hitStumps, 'the ball was going on to hit the stumps');
            assert.ok(first.p[1] >= -PITCH.stumpsHalfWidth, 'it did not pitch outside leg stump');
            if (o.shot === 'leave') assert.ok(o.contact.p[1] >= -PITCH.stumpsHalfWidth, 'no shot: struck in line or outside off');
            else assert.ok(Math.abs(o.contact.p[1]) <= PITCH.stumpsHalfWidth, 'playing a shot: struck in line');
          }
          if (o.result.how === 'pad') {
            notOut++;
            assert.equal(o.result.wicket, null);
            const pitchedOutsideLeg = first.p[1] < -PITCH.stumpsHalfWidth;
            const outsideLine = Math.abs(o.contact.p[1]) > PITCH.stumpsHalfWidth;
            assert.ok(pitchedOutsideLeg || outsideLine || !sim.main.hitStumps, 'not out needs a reason in law');
          }
        }
      }
    }
  }
  assert.ok(lbw >= 5 && notOut >= 5, `saw ${lbw} lbw and ${notOut} not-out pad strikes`);
});

test('bowled only when the ball really hits the stumps', () => {
  const rng = mulberry32(31);
  let bowled = 0, missed = 0;
  for (const line of [-12, 0, 12, 28]) {
    for (const length of [1.2, 3.5, 6]) {
      for (const angle of [-22, 0, 22]) {
        const cfg = cfgWith((c) => { c.delivery.length = length; c.delivery.line = line; c.seam.angle = angle; c.delivery.speedKmh = 138; });
        const sim = simulate(cfg);
        for (let i = 0; i < 40; i++) {
          const o = faceBall(sim, cfg, ctx({ aggression: 0.06, need: Infinity }), rng);
          if (o.result.how === 'bowled') { bowled++; assert.ok(sim.main.hitStumps, 'bowled means the stumps were hit'); }
          if (o.quality === 'miss' && !sim.main.hitStumps) { missed++; assert.notEqual(o.result.wicket, 'bowled'); }
        }
      }
    }
  }
  assert.ok(bowled >= 5 && missed >= 5, `saw ${bowled} bowled and ${missed} play-and-misses`);
});

// ------------------------------------------------------------------- the over
const ball = (runs, extra = null, wicket = null) => ({ legal: !extra, extra, result: { runs, wicket } });
// a chase with fixed numbers, so retuning the real scenarios does not disturb these tests
const chase = (need, wickets = 3) => ({ ...SCENARIOS.find((s) => s.goal === 'chase'), need, wickets, field: 'spread', aggression: undefined });

test('over: six legal balls, wides and no-balls bowled again', () => {
  const over = newOver(chase(9));
  recordBall(over, ball(1, 'wide'));
  recordBall(over, ball(5, 'noball'));
  assert.equal(over.balls, 0);
  assert.equal(over.runs, 6);
  for (let i = 0; i < 5; i++) recordBall(over, ball(0));
  assert.equal(over.done, false);
  recordBall(over, ball(0));
  assert.equal(over.balls, 6);
  assert.equal(over.done, true);
  assert.equal(over.result, 'won');
  assert.equal(over.log.length, 8);
});

test('over: the chase is lost the moment the target is reached', () => {
  const over = newOver(chase(9));
  recordBall(over, ball(4)); recordBall(over, ball(4));
  assert.equal(over.done, false);
  recordBall(over, ball(1));
  assert.equal(over.done, true);
  assert.equal(over.result, 'lost');
  recordBall(over, ball(6)); // nothing more is recorded once it is over
  assert.equal(over.runs, 9);
  assert.equal(over.log.length, 3);
});

test('over: one short of the target is a tie, two short is a win', () => {
  const sc = chase(9);
  const tie = newOver(sc);
  recordBall(tie, ball(4)); recordBall(tie, ball(4));
  for (let i = 0; i < 4; i++) recordBall(tie, ball(0));
  assert.equal(tie.result, 'tied');
  const win = newOver(sc);
  recordBall(win, ball(4)); recordBall(win, ball(3));
  for (let i = 0; i < 4; i++) recordBall(win, ball(0));
  assert.equal(win.result, 'won');
  assert.match(standing(win), /Defended by 1 run$/);
});

test('over: taking the last wicket wins a chase', () => {
  const over = newOver(chase(6, 1));
  recordBall(over, ball(2));
  recordBall(over, ball(0, null, 'bowled'));
  assert.equal(over.done, true);
  assert.equal(over.result, 'won');
});

test('over: in a wicket challenge only a wicket wins', () => {
  const sc = SCENARIOS.find((s) => s.id === 'save-the-test');
  const lost = newOver(sc);
  for (let i = 0; i < 6; i++) recordBall(lost, ball(i === 2 ? 4 : 0));
  assert.equal(lost.result, 'lost');
  const won = newOver(sc);
  recordBall(won, ball(0)); recordBall(won, ball(0, null, 'caught'));
  assert.equal(won.result, 'won');
  assert.equal(won.balls, 2);
});

test('situation: what the batter is told tracks the over', () => {
  const over = newOver(chase(9));
  recordBall(over, ball(4)); recordBall(over, ball(0, null, 'caught'));
  assert.deepEqual(situation(over), { need: 5, ballsLeft: 4, wicketsLeft: 2, field: 'spread', aggression: undefined });
});

test('scenarios: each one is complete and takes over only what a bowler cannot choose', () => {
  assert.ok(SCENARIOS.length >= 5);
  const ids = new Set();
  for (const sc of SCENARIOS) {
    ids.add(sc.id);
    for (const k of ['title', 'story', 'ballAge', 'pitchNote', 'skyNote']) assert.ok(sc[k] && sc[k].length > 3, `${sc.id}.${k}`);
    assert.ok(sc.goal === 'chase' || sc.goal === 'wicket');
    assert.ok(sc.field in FIELDS);
    if (sc.goal === 'chase') assert.ok(sc.need >= 2 && sc.wickets >= 1);
    const mine = cfgWith((c) => { c.delivery.speedKmh = 141; c.seam.angle = -7; });
    const applied = applyScenario(mine, sc);
    assert.equal(applied.delivery.speedKmh, 141);
    assert.equal(applied.seam.angle, -7);
    assert.deepEqual(applied.ball, sc.ball);
    assert.deepEqual(applied.pitch, sc.pitch);
    assert.equal(applied.seam.condition, sc.seamCondition);
    assert.equal(mine.seam.condition, 100, 'the original settings are not modified');
  }
  assert.equal(ids.size, SCENARIOS.length);
});

test('delivery scatter: close to the aim, wider for a yorker than for a short ball', () => {
  const spread = (length) => {
    const rng = mulberry32(9);
    const base = cfgWith((c) => { c.delivery.length = length; c.delivery.line = 10; });
    const ls = [], lines = [];
    for (let i = 0; i < 2000; i++) { const d = deliver(base, rng, i); ls.push(d.delivery.length); lines.push(d.delivery.line); }
    const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    return { length: sd(ls), line: sd(lines) };
  };
  const yorker = spread(1.5), good = spread(6.5), short = spread(10);
  assert.ok(good.length > 0.25 && good.length < 0.35, `good length scatter ${good.length}`);
  assert.ok(good.line > 5 && good.line < 7, `line scatter ${good.line} cm`);
  assert.ok(yorker.length > 1.6 * good.length && good.length > 1.6 * short.length, `${yorker.length} > ${good.length} > ${short.length}`);
  const base = cfgWith(() => {});
  assert.equal(deliver(base, mulberry32(1), 77).seed, 77);
  assert.deepEqual(base, DEFAULTS, 'the aim itself is left untouched');
});

// ------------------------------------------------------------ after the bat
test('field: both fields have a keeper, nine fielders, all inside the rope', () => {
  for (const name of ['slips', 'spread']) {
    const f = FIELDS[name];
    assert.equal(Object.keys(f).length, 10);
    assert.ok(f.keeper && f.keeper.at[0] > S + 5);
    for (const id in f) assert.ok(Math.hypot(f[id].at[0] - S / 2, f[id].at[1]) < 66, `${name}.${id} is inside the boundary`);
    for (const kind of ['behind', 'slip', 'drive', 'cut', 'pull', 'flick', 'hook', 'slog', 'top']) assert.ok(catcher(name, kind).at, `${name} has a catcher for ${kind}`);
  }
});

test('flight: every outcome gives a continuous, finite path that starts as the simulated ball', () => {
  const rng = mulberry32(41);
  const seen = new Set();
  for (let i = 0; i < 700; i++) {
    const cfg = cfgWith((c) => {
      c.delivery.speedKmh = 80 + Math.floor(rng() * 75); c.delivery.length = rng() * 13; c.delivery.line = -50 + rng() * 135;
      c.seam.angle = -30 + rng() * 60; c.ball = { wearOff: rng() * 100, wearLeg: rng() * 100 }; c.pitch.wear = rng() * 80; c.seed = i + 1;
    });
    const sim = simulate(cfg);
    const field = i % 2 ? 'slips' : 'spread';
    const o = faceBall(sim, cfg, ctx({ field, need: 1 + Math.floor(rng() * 14), ballsLeft: 1 + Math.floor(rng() * 6) }), rng);
    const f = flightAfter(sim, o, field, rng);
    seen.add(o.result.how);
    assert.ok(f.samples.length >= 2);
    assert.equal(f.samples[0].t, sim.main.samples[0].t);
    assert.deepEqual(f.samples[0].p, sim.main.samples[0].p);
    for (let k = 1; k < f.samples.length; k++) {
      const a = f.samples[k - 1], b = f.samples[k];
      assert.ok(b.p.every(Number.isFinite) && b.v.every(Number.isFinite), `${o.result.how}: finite`);
      assert.ok(b.t >= a.t - 1e-9, `${o.result.how}: time runs forward`);
      const jump = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
      assert.ok(jump < 0.9, `${o.result.how}/${o.quality}: no teleporting (${jump.toFixed(2)} m between samples)`);
      assert.ok(b.p[2] > -0.01, `${o.result.how}: stays above the ground`);
    }
    assert.ok(Math.abs(f.endTime - f.samples[f.samples.length - 1].t) < 1e-9);
    if (o.result.wicket === 'bowled') assert.ok(f.stumpsTime !== null, 'the stumps go when bowled');
    else assert.equal(f.stumpsTime, null, `${o.result.how}: the stumps stay up`);
    if (o.result.wicket === 'caught') {
      assert.ok(f.caughtBy && FIELDS[field][f.caughtBy], 'caught by a fielder who is on the field');
      const end = f.samples[f.samples.length - 1].p, who = FIELDS[field][f.caughtBy].at;
      assert.ok(Math.hypot(end[0] - who[0], end[1] - who[1]) < 0.6, 'and the ball ends in their hands');
    }
  }
  for (const how of ['hit', 'edge', 'wide', 'leave', 'beaten', 'bowled', 'caught-field']) assert.ok(seen.has(how), `exercised "${how}"`);
});
