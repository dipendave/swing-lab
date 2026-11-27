// Checks the physics engine against published behaviour of real cricket balls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulate, swingCurve, airProperties, makePitch, magnusCoefficient, flowSnapshot,
  DEFAULTS, BALL, PITCH, _internal,
} from '../src/physics.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const cfgWith = (fn) => { const c = clone(DEFAULTS); fn(c); return c; };
const csAt = (cfg, kmh) => swingCurve(cfg, [kmh])[0].cs;
const range = (a, b, step) => { const r = []; for (let x = a; x <= b; x += step) r.push(x); return r; };

test('air: ISA sea-level density and viscosity', () => {
  const a = airProperties({ tempC: 15, humidity: 0, altitude: 0 });
  assert.ok(Math.abs(a.rho - 1.225) < 0.002);
  assert.ok(Math.abs(a.mu - 1.789e-5) < 0.01e-5);
});

test('air: humid air is slightly less dense than dry air, by under 2%', () => {
  const dry = airProperties({ tempC: 25, humidity: 0 }).rho;
  const wet = airProperties({ tempC: 25, humidity: 100 }).rho;
  assert.ok(wet < dry);
  assert.ok((dry - wet) / dry < 0.02);
});

test('air: thinner at altitude (Johannesburg is about 19% down on sea level)', () => {
  const sea = airProperties({ tempC: 20, altitude: 0 }).rho;
  const high = airProperties({ tempC: 20, altitude: 1750 }).rho;
  assert.ok(high / sea > 0.78 && high / sea < 0.84);
});

test('conventional swing: new ball, 20 deg seam, peaks near 0.3 around 108 km/h toward the seam', () => {
  const cs = csAt(DEFAULTS, 108);
  assert.ok(cs > 0.24 && cs < 0.34, `cs=${cs}`);
  const curve = swingCurve(DEFAULTS, range(60, 160, 4));
  const peak = curve.reduce((m, p) => (p.cs > m.cs ? p : m));
  assert.ok(peak.kmh >= 90 && peak.kmh <= 124, `peak at ${peak.kmh}`);
});

test('conventional swing weakens at low speed, and a bigger seam angle helps there', () => {
  assert.ok(csAt(DEFAULTS, 60) < 0.7 * csAt(DEFAULTS, 108));
  const wide = cfgWith((c) => { c.seam.angle = 35; });
  assert.ok(csAt(wide, 60) > csAt(DEFAULTS, 60));
});

test('new ball reverses only at express pace, and reverse is weaker than conventional', () => {
  const curve = swingCurve(DEFAULTS, range(100, 165, 1));
  const zero = curve.find((p) => p.cs < 0);
  assert.ok(zero && zero.kmh >= 134 && zero.kmh <= 150, `zero crossing at ${zero && zero.kmh}`);
  const rev = csAt(DEFAULTS, 158);
  assert.ok(rev < -0.05 && Math.abs(rev) < 0.8 * csAt(DEFAULTS, 108));
});

test('seam straight on a new ball gives no side force', () => {
  const c = cfgWith((x) => { x.seam.angle = 0; });
  for (const v of [70, 110, 150]) assert.ok(Math.abs(csAt(c, v)) < 0.005);
});

test('mirror symmetry: flipping the seam flips the force exactly', () => {
  const m = cfgWith((x) => { x.seam.angle = -20; });
  for (const v of [80, 120, 150]) assert.ok(Math.abs(csAt(DEFAULTS, v) + csAt(m, v)) < 1e-9);
});

test('old ball, shiny side leading: reverse swing arrives well below new-ball speeds and is strong', () => {
  const old = cfgWith((c) => { c.ball = { wearOff: 85, wearLeg: 25 }; c.seam.condition = 60; });
  const curve = swingCurve(old, range(80, 160, 1));
  const zero = curve.find((p) => p.cs < 0);
  assert.ok(zero.kmh >= 100 && zero.kmh <= 128, `old-ball reversal at ${zero.kmh}`);
  assert.ok(csAt(old, 145) < -0.15);
});

test('contrast swing: seam straight, toward the rough side when slow, the smooth side when fast', () => {
  const c = cfgWith((x) => { x.seam.angle = 0; x.ball = { wearOff: 90, wearLeg: 25 }; });
  assert.ok(csAt(c, 95) > 0.1, 'slow: toward rough (off) side');
  assert.ok(csAt(c, 145) < -0.05, 'fast: toward smooth (leg) side');
});

test('a worn, flat seam swings a new-leather ball far less', () => {
  const flat = cfgWith((c) => { c.seam.condition = 15; });
  assert.ok(csAt(flat, 108) < 0.5 * csAt(DEFAULTS, 108));
});

test('a seam wobbling evenly about straight averages to no swing', () => {
  const w = cfgWith((c) => { c.seam.angle = 0; c.seam.wobble = 20; });
  assert.ok(Math.abs(csAt(w, 120)) < 0.01);
});

test('drag coefficient: about 0.5 subcritical, lower once the layer is turbulent', () => {
  const smoothSeam = cfgWith((c) => { c.seam.angle = 0; c.seam.condition = 0; });
  const lo = swingCurve(smoothSeam, [50])[0].cd;
  const hi = swingCurve(DEFAULTS, [160])[0].cd;
  assert.ok(lo > 0.44 && lo < 0.54, `subcritical cd=${lo}`);
  assert.ok(hi > 0.2 && hi < 0.35, `supercritical cd=${hi}`);
});

test('Magnus lift coefficient matches the Nathan fit', () => {
  assert.ok(Math.abs(magnusCoefficient(0.1) - 1 / 6.32) < 1e-12);
  assert.equal(magnusCoefficient(0), 0);
});

test('aim: the no-movement reference delivery pitches on the requested line and length', () => {
  for (const [speed, length, line] of [[132, 6.5, 20], [90, 4, -10], [150, 10, 0], [75, 3, 30]]) {
    const r = simulate(cfgWith((c) => { c.delivery.speedKmh = speed; c.delivery.length = length; c.delivery.line = line; }));
    const b = r.ref.bounces[0].p;
    assert.ok(Math.abs(PITCH.length - b[0] - length) < 0.01, `length ${PITCH.length - b[0]} vs ${length}`);
    assert.ok(Math.abs(b[1] - line / 100) < 0.005, `line ${b[1]} vs ${line / 100}`);
  }
});

test('flight: outswinger moves to the off side, inswinger mirrors it', () => {
  const base = (ang) => cfgWith((c) => {
    c.seam.angle = ang; c.delivery.speedKmh = 125; c.delivery.releaseY = 0; c.delivery.line = 0;
    c.pitch.wear = 0;
  });
  const out = simulate(base(20)).metrics;
  const inn = simulate(base(-20)).metrics;
  assert.ok(out.swing > 0.05, `outswing ${out.swing}`);
  assert.ok(Math.abs(out.swing + inn.swing) < 0.002, 'mirror image in the air');
});

test('flight: a full 108 km/h new-ball outswinger moves 0.4 to 0.9 m (Mehta: up to ~0.8 m)', () => {
  const r = simulate(cfgWith((c) => { c.delivery.speedKmh = 108; c.delivery.length = 1; })).metrics;
  assert.ok(r.swing > 0.4 && r.swing < 0.9, `swing ${r.swing}`);
});

test('flight: swing is late - more than half of it comes in the last 40% of the flight', () => {
  const r = simulate(cfgWith((c) => { c.delivery.speedKmh = 120; c.delivery.length = 2; }));
  const main = r.main.samples, ref = r.ref.samples;
  const xB = r.main.bounces[0].p[0];
  const x0 = main[0].p[0];
  const at = (arr, x) => { const s = arr.find((q) => q.p[0] >= x); return s.p[1]; };
  const xMid = x0 + 0.6 * (xB - x0);
  const early = at(main, xMid) - at(ref, xMid);
  assert.ok(early < 0.5 * r.metrics.swing, `early ${early} of ${r.metrics.swing}`);
});

test('flight: plausible pace through the air and off the pitch', () => {
  const m = simulate(DEFAULTS).metrics;
  const airLoss = 1 - m.pitched.speedIn / m.releaseSpeed;
  const pitchLoss = 1 - m.pitched.speedOut / m.pitched.speedIn;
  assert.ok(airLoss > 0.02 && airLoss < 0.1, `air loss ${airLoss}`);
  assert.ok(pitchLoss > 0.06 && pitchLoss < 0.22, `pitch loss ${pitchLoss}`);
  assert.ok(m.atStumps.z > 0.3 && m.atStumps.z < 1.1, `good length reaches the stumps at ${m.atStumps.z} m`);
  assert.ok(m.atStumps.t > 0.45 && m.atStumps.t < 0.65, `time to stumps ${m.atStumps.t}`);
});

test('flight: the ball never goes below the pitch', () => {
  const r = simulate(DEFAULTS);
  for (const s of r.main.samples) assert.ok(s.p[2] >= BALL.radius - 1e-6);
});

test('bounce: energy is lost, and backspin turns into topspin under friction', () => {
  const pitch = makePitch({});
  const b = _internal.bounce([35, 0, -7], [0, -80, 0], null, pitch, null, null);
  assert.ok(b.v[2] > 0 && b.v[2] < 7);
  assert.ok(b.v[0] < 35 && b.v[0] > 25);
  assert.ok(b.w[1] > -80, 'friction torque adds topspin');
});

test('bounce: a slow, steep ball grips and leaves rolling (no residual slip)', () => {
  const pitch = makePitch({ wear: 80 });
  const b = _internal.bounce([4, 0, -9], [0, 0, 0], null, pitch, null, null);
  assert.ok(b.gripped);
  assert.ok(Math.abs(b.v[0] - BALL.radius * b.w[1]) < 1e-6);
});

test('seam movement: an angled seam landing on a green pitch deviates the way the seam points', () => {
  const green = (ang) => cfgWith((c) => {
    c.seam.angle = ang; c.pitch = { hardness: 70, grass: 90, moisture: 30, wear: 0 };
    c.delivery.speedKmh = 135;
  });
  const out = simulate(green(20)).metrics.pitched;
  const inn = simulate(green(-20)).metrics.pitched;
  assert.ok(out.deviation > 0.3 && out.deviation < 4, `deviation ${out.deviation}`);
  assert.ok(inn.deviation < -0.3);
  assert.ok(out.seamContact > 0.9);
});

test('pitch: harder pitches bounce more, damp ones less', () => {
  const hard = makePitch({ hardness: 100, moisture: 0 });
  const damp = makePitch({ hardness: 30, moisture: 80 });
  assert.ok(hard.restitution > damp.restitution + 0.1);
  assert.ok(damp.friction > hard.friction);
});

test('wind: a headwind slows the ball more than a tailwind', () => {
  const head = simulate(cfgWith((c) => { c.weather.windKmh = 30; c.weather.windDir = 0; })).metrics;
  const tail = simulate(cfgWith((c) => { c.weather.windKmh = 30; c.weather.windDir = 180; })).metrics;
  assert.ok(head.pitched.speedIn < tail.pitched.speedIn);
});

test('tilted seam with backspin drifts toward the lean (Magnus)', () => {
  const lean = (t) => cfgWith((c) => { c.seam.angle = 0; c.seam.tilt = t; c.seam.spin = 25; c.delivery.length = 3; });
  assert.ok(simulate(lean(30)).metrics.swing > 0.02);
  assert.ok(simulate(lean(-30)).metrics.swing < -0.02);
});

test('flow snapshot: conventional swing has a turbulent seam side and a laminar far side', () => {
  const r = simulate(cfgWith((c) => { c.delivery.speedKmh = 110; }));
  const f = flowSnapshot(cfgWith((c) => { c.delivery.speedKmh = 110; }), r.main.samples[0]);
  assert.ok(f.left.turb > 0.9 && f.right.turb < 0.1);
  assert.ok(f.left.sep > f.right.sep + 10);
  assert.ok(Math.abs(f.seamYaw - 20) < 3, `seam yaw ${f.seamYaw}`);
});

test('determinism: same seed, same delivery', () => {
  const a = simulate(cfgWith((c) => { c.pitch.wear = 80; c.seed = 7; })).metrics;
  const b = simulate(cfgWith((c) => { c.pitch.wear = 80; c.seed = 7; })).metrics;
  const c2 = simulate(cfgWith((c) => { c.pitch.wear = 80; c.seed = 8; })).metrics;
  assert.equal(a.pitched.deviation, b.pitched.deviation);
  assert.notEqual(a.pitched.deviation, c2.pitched.deviation);
});
