// Swing Lab: wires the controls to the physics engine and the 3D view.
import { simulate, swingCurve, flowSnapshot, lengthName, DEFAULTS, BALL, PITCH } from './physics.js';
import { World } from './scene.js';
import { FlowDiagram, SwingCurve } from './panels.js';
import { initAnalytics, track } from './analytics.js';
import { faceBall, SHOTS } from './batter.js';
import { SCENARIOS, applyScenario, newOver, situation, recordBall, standing, deliver, mulberry32 } from './challenge.js';
import { flightAfter } from './field.js';
import { RUNUP } from './pose.js';

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const get = (o, path) => path.split('.').reduce((a, k) => a[k], o);
const set = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const cm = (m) => Math.round(Math.abs(m) * 100);
const G = 9.80665;

// ------------------------------------------------------------------- wording
const sideWord = (v, off = 'off', leg = 'leg') => (v > 0 ? off : leg);
function lineWords(v) {
  const a = Math.abs(v);
  if (a <= 4) return 'on middle stump';
  if (a <= 13) return v > 0 ? 'on off stump' : 'on leg stump';
  return v > 0 ? `${Math.round(a - 11)} cm outside off stump` : `${Math.round(a - 11)} cm outside leg stump`;
}
function wearWords(v) {
  if (v < 5) return 'New';
  if (v < 25) return 'Still shiny';
  if (v < 50) return 'Dulled';
  if (v < 75) return 'Rough';
  return 'Scuffed';
}
function windWords(deg) {
  const d = ((deg % 360) + 360) % 360;
  const names = ['Headwind', 'Head, across from off', 'From the off side', 'Tail, across from off', 'Tailwind', 'Tail, across from leg', 'From the leg side', 'Head, across from leg'];
  return names[Math.round(d / 45) % 8];
}

// ------------------------------------------------------------------ controls
const GROUPS = [
  {
    id: 'delivery', title: 'Delivery', open: true,
    gist: (c) => `${c.delivery.speedKmh} km/h, ${lengthName(c.delivery.length).toLowerCase()}`,
    controls: [
      { key: 'delivery.speedKmh', label: 'Speed at release', wide: true, min: 60, max: 160, step: 1, fmt: (v) => `${v} km/h`, note: (v) => `${(v / 1.609344).toFixed(0)} mph` },
      { key: 'delivery.length', label: 'Length', wide: true, min: 0, max: 14, step: 0.1, fmt: (v) => `${v.toFixed(1)} m`, note: (v) => `${lengthName(v)}, from the batter's stumps` },
      { key: 'delivery.line', label: 'Line', wide: true, min: -60, max: 80, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v} cm`, note: (v) => `Aimed to pitch ${lineWords(v)}` },
      { key: 'delivery.releaseHeight', label: 'Release height', wide: true, min: 1.7, max: 2.5, step: 0.01, fmt: (v) => `${v.toFixed(2)} m`, note: () => 'Height of the hand when the ball leaves it' },
      { key: 'delivery.releaseY', label: 'Release side', wide: true, min: -1.2, max: 1.2, step: 0.01, fmt: (v) => `${cm(v)} cm ${Math.abs(v) < 0.005 ? '' : sideWord(v)}`.trim(),
        note: (v) => (Math.abs(v) < 0.03 ? 'Over the top of the stumps' : `Hand ${sideWord(v, 'to the off side', 'to the leg side')} of the stumps`) },
    ],
  },
  {
    id: 'seam', title: 'Seam', open: true,
    gist: (c) => `${c.seam.angle}°, ${c.seam.spin} rev/s`,
    controls: [
      { key: 'seam.angle', label: 'Seam angle', min: -45, max: 45, step: 1, fmt: (v) => `${Math.abs(v)}°${v ? ' ' + sideWord(v) : ''}`,
        note: (v) => (v === 0 ? 'Pointing straight down the pitch' : v > 0 ? 'Pointing toward the slips' : 'Pointing toward fine leg') },
      { key: 'seam.tilt', label: 'Seam tilt', min: -40, max: 40, step: 1, fmt: (v) => `${Math.abs(v)}°${v ? ' ' + sideWord(v) : ''}`,
        note: (v) => (v === 0 ? 'Bolt upright' : `Top of the seam leaning toward ${sideWord(v)}`) },
      { key: 'seam.spin', label: 'Backspin', min: 0, max: 40, step: 0.5, fmt: (v) => `${v} rev/s`, note: (v) => `${Math.round(v * 60)} rpm. Steadies the seam and adds lift` },
      { key: 'seam.wobble', label: 'Wobble', min: 0, max: 90, step: 1, fmt: (v) => `${v}°`,
        note: (v) => (v === 0 ? 'Released perfectly' : v < 8 ? 'A slight flutter' : v < 35 ? 'Wobble seam' : v < 70 ? 'Scrambled seam' : 'Cross seam, tumbling') },
      { key: 'seam.condition', label: 'Seam condition', wide: true, min: 0, max: 100, step: 1, fmt: (v) => `${v}%`,
        note: (v) => (v > 75 ? 'Proud, fresh stitching' : v > 40 ? 'Bedded in' : v > 15 ? 'Worn low' : 'Flat') },
    ],
  },
  {
    id: 'ball', title: 'Ball', open: true,
    gist: (c) => `seam ${Math.abs(c.seam.angle)}°${c.seam.angle ? ' ' + sideWord(c.seam.angle) : ''}`,
    chips: [
      ['New ball', { ball: { wearOff: 0, wearLeg: 0 }, seam: { condition: 100 } }],
      ['25 overs, one side shined', { ball: { wearOff: 45, wearLeg: 12 }, seam: { condition: 80 } }],
      ['60 overs, reversing', { ball: { wearOff: 88, wearLeg: 28 }, seam: { condition: 55 } }],
    ],
    controls: [
      { key: 'ball.wearOff', label: 'Off side wear', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`,
        note: (v, c, s) => `${wearWords(v)}. Air turns turbulent above ${Math.round(s.critOff * 3.6)} km/h` },
      { key: 'ball.wearLeg', label: 'Leg side wear', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`,
        note: (v, c, s) => `${wearWords(v)}. Air turns turbulent above ${Math.round(s.critLeg * 3.6)} km/h` },
    ],
  },
  {
    id: 'weather', title: 'Weather', open: false,
    gist: (c) => `${c.weather.tempC}°C, ${c.weather.cloud > 66 ? 'overcast' : c.weather.cloud > 33 ? 'broken cloud' : 'sunny'}`,
    chips: [
      ['Overcast Leeds morning', { weather: { tempC: 14, humidity: 82, altitude: 50, cloud: 95, windKmh: 8, windDir: 300 } }],
      ['Hot Perth afternoon', { weather: { tempC: 36, humidity: 22, altitude: 20, cloud: 5, windKmh: 26, windDir: 150 } }],
      ['Humid Mumbai evening', { weather: { tempC: 30, humidity: 85, altitude: 10, cloud: 45, windKmh: 10, windDir: 90 } }],
      ['Johannesburg, 1750 m up', { weather: { tempC: 24, humidity: 35, altitude: 1750, cloud: 25, windKmh: 6, windDir: 0 } }],
    ],
    controls: [
      { key: 'weather.tempC', label: 'Temperature', min: 0, max: 45, step: 1, fmt: (v) => `${v}°C`, note: (v, c, s) => `Air density ${s.rho.toFixed(3)} kg/m³` },
      { key: 'weather.humidity', label: 'Humidity', min: 10, max: 100, step: 1, fmt: (v) => `${v}%`, note: () => 'Thins the air by under 1%. Not why it swings' },
      { key: 'weather.altitude', label: 'Altitude', min: 0, max: 2000, step: 10, fmt: (v) => `${v} m`, note: (v) => (v > 800 ? 'Thin air: less drag, less swing' : 'Near sea level') },
      { key: 'weather.cloud', label: 'Cloud', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`,
        note: (v) => (v > 66 ? 'Still air keeps the smooth side laminar' : v > 33 ? 'Some sun stirring the air over the outfield' : 'Sun on the outfield stirs up the air') },
      { key: 'weather.windKmh', label: 'Wind', min: 0, max: 50, step: 1, fmt: (v) => `${v} km/h`, note: (v) => (v === 0 ? 'Calm' : '') },
      { key: 'weather.windDir', label: 'Wind from', min: 0, max: 355, step: 5, fmt: (v) => `${v}°`, note: (v) => windWords(v) },
    ],
  },
  {
    id: 'pitch', title: 'Pitch', open: false,
    gist: (c, s) => `bounce ${s.restitution.toFixed(2)}, grip ${s.friction.toFixed(2)}`,
    chips: [
      ['Green seamer', { pitch: { hardness: 68, grass: 88, moisture: 38, wear: 0 } }],
      ['Hard and bouncy', { pitch: { hardness: 100, grass: 30, moisture: 0, wear: 10 } }],
      ['Flat road', { pitch: { hardness: 80, grass: 8, moisture: 5, wear: 12 } }],
      ['Day-five dustbowl', { pitch: { hardness: 45, grass: 0, moisture: 0, wear: 95 } }],
      ['Damp and slow', { pitch: { hardness: 30, grass: 40, moisture: 85, wear: 15 } }],
    ],
    controls: [
      { key: 'pitch.hardness', label: 'Hardness', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`, note: (v, c, s) => `Ball keeps ${Math.round(s.restitution * 100)}% of its vertical speed` },
      { key: 'pitch.grass', label: 'Live grass', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`, note: (v) => (v > 60 ? 'The seam bites and the ball skids on' : v > 25 ? 'Some help for the seam' : 'Bare') },
      { key: 'pitch.moisture', label: 'Moisture', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`, note: (v) => (v > 60 ? 'Tacky: slow, low bounce' : v > 25 ? 'A little damp' : 'Dry') },
      { key: 'pitch.wear', label: 'Cracks', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`, note: (v, c, s) => (v > 50 ? 'Uneven bounce. Every ball lands differently' : `Friction ${s.friction.toFixed(2)}`) },
    ],
  },
];

const PRESETS = [
  ['New-ball outswinger', {}],
  ['New-ball inswinger', { seam: { angle: -20 }, delivery: { line: 45, length: 5.5 } }],
  ['Medium-pace hooping outswinger', { delivery: { speedKmh: 112, length: 4.2, line: -5 }, seam: { angle: 22, spin: 11 } }],
  ['Express pace, new ball going straight', { delivery: { speedKmh: 143, length: 6.2, line: 12 } }],
  ['Wobble seam', { seam: { angle: 0, wobble: 22, spin: 14 }, delivery: { speedKmh: 136, line: 14, length: 6.6 }, pitch: { hardness: 68, grass: 70, moisture: 25, wear: 5 } }],
  ['Reverse-swinging yorker, 60-over ball', { delivery: { speedKmh: 146, length: 1.6, line: 42, releaseY: 0.55 }, seam: { angle: 20, spin: 14, condition: 55 }, ball: { wearOff: 88, wearLeg: 28 },
    weather: { tempC: 31, humidity: 40, altitude: 200, cloud: 20, windKmh: 5, windDir: 0 }, pitch: { hardness: 70, grass: 4, moisture: 0, wear: 55 } }],
  ['Contrast swing, seam dead straight', { delivery: { speedKmh: 104, length: 4.2, line: -12 }, seam: { angle: 0, condition: 45 }, ball: { wearOff: 90, wearLeg: 18 } }],
  ['Cross-seam bouncer', { delivery: { speedKmh: 142, length: 10.5, line: 0 }, seam: { angle: 0, wobble: 90, spin: 18 }, pitch: { hardness: 100, grass: 30, moisture: 0, wear: 10 } }],
  ['Leaning seam, drifting on backspin', { delivery: { speedKmh: 96, length: 4.5, line: 0, releaseY: 0.3 }, seam: { angle: 0, tilt: 35, spin: 32 } }],
];

// --------------------------------------------------------------------- state
const state = {
  cfg: clone(DEFAULTS),
  sim: null,
  curve: null,
  t: 0,
  playing: false,
  rate: 0.25,
  pinned: null,
  derived: { critOff: 0, critLeg: 0, rho: 1.2, restitution: 0.57, friction: 0.33 },
  dirty: { sim: true, ball: true, pitch: true, weather: true },
  lastIndex: -1,
  // challenge mode
  mode: 'free', // 'free' | 'challenge'
  scenarioIndex: 0,
  over: null, // the over in progress
  play: null, // the ball just bowled in a challenge: what happened and the flight to show
  rng: null,
  tally: { played: 0, won: 0 },
};

// Where the playhead starts. The ball leaves the hand at 0; with the players
// on the ground the bowler has to run in first.
const startTime = () => (state.mode === 'challenge' && world && world.hasPeople() ? -RUNUP : 0);

// What is on screen: the ball just bowled in a challenge, or else the preview
// of the current settings.
const shownSim = () => (state.play ? state.play.sim : state.sim);
const shownCfg = () => (state.play ? state.play.cfg : state.cfg);
const shownSamples = () => (state.play ? state.play.samples : state.sim.main.samples);

let world = null;
try {
  world = new World($('view'), $('ball-view'));
} catch (err) {
  console.error(err);
  const f = $('fallback');
  f.hidden = false;
  f.textContent = 'The 3D view needs WebGL, which this browser did not provide. The physics readouts on the right still work.';
  document.body.classList.add('no-webgl');
}
const flow = new FlowDiagram($('flow'));
const chart = new SwingCurve($('curve'));
// the players arrive a moment after the page: put the bowler back at the mark
if (world) {
  world.peopleReady.then(() => {
    if (!state.playing && state.t === 0 && startTime() < 0) { state.t = startTime(); state.needsFrame = true; }
  });
}
// a handle for looking around from the console: add ?debug to the address
if (new URLSearchParams(location.search).has('debug')) window.swinglab = { world, state };

// ------------------------------------------------------------ build controls
// The controls live in four panels: ball and seam, delivery, weather, pitch.
// On a wide screen they sit in the corners of the play screen; on a narrow one
// they dock into the left column (see placePanels).
const controlEls = [];
const chipEls = {}; // group id -> its "start from" menu
const PANEL_OF = { ball: 'ball', seam: 'ball', delivery: 'delivery', weather: 'weather', pitch: 'pitch' };
const CHIP_PROMPT = { ball: 'Ball age', weather: 'Start from a kind of day', pitch: 'Start from a kind of pitch' };
const hints = {}; // panel id -> { el, active }: the control whose note is showing
const fixedInChallenge = (groupId, key) => groupId === 'ball' || groupId === 'weather' || groupId === 'pitch' || key === 'seam.condition';

function buildControls() {
  for (const g of GROUPS) {
    const host = $(`ctl-${g.id}`);
    const panel = PANEL_OF[g.id];
    for (const c of g.controls) {
      const wrap = document.createElement('label');
      wrap.className = c.wide ? 'ctl wide' : 'ctl';
      const nm = document.createElement('span'); nm.className = 'ctl-name'; nm.textContent = c.label;
      const out = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range'; input.min = c.min; input.max = c.max; input.step = c.step;
      wrap.append(nm, out, input);
      host.appendChild(wrap);
      const entry = { c, input, out, wrap, panel, fixed: fixedInChallenge(g.id, c.key) };
      if (!hints[panel]) hints[panel] = { el: $(`hint-${panel}`), active: entry };
      const show = () => { hints[panel].active = entry; writeHint(panel); };
      wrap.addEventListener('pointerenter', show);
      input.addEventListener('focus', show);
      input.addEventListener('input', () => {
        set(state.cfg, c.key, Number(input.value));
        hints[panel].active = entry;
        if (chipEls[g.id]) chipEls[g.id].value = '';
        changed(g.id);
      });
      controlEls.push(entry);
    }
    if (g.chips) {
      const menu = $(`chips-${g.id}`);
      const first = document.createElement('option');
      first.value = ''; first.textContent = CHIP_PROMPT[g.id];
      menu.appendChild(first);
      g.chips.forEach(([label], i) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = label;
        menu.appendChild(o);
      });
      menu.addEventListener('change', () => {
        if (menu.value === '') return;
        applyPatch(g.chips[Number(menu.value)][1]);
        changed(g.id);
      });
      chipEls[g.id] = menu;
    }
  }
  // which side of the ball to shine is the bowler's call, in a challenge too
  $('swap').addEventListener('click', () => {
    const { wearOff, wearLeg } = state.cfg.ball;
    state.cfg.ball.wearOff = wearLeg; state.cfg.ball.wearLeg = wearOff;
    changed('ball');
  });

  const sel = $('preset');
  PRESETS.forEach(([label], i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = label;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    if (state.mode === 'challenge') {
      // only the bowler's own choices change: the ball, pitch and weather belong to the challenge
      loadBowlerChoices(PRESETS[Number(sel.value)][1]);
      track('preset_loaded', { preset_name: PRESETS[Number(sel.value)][0] });
      return;
    }
    state.cfg = clone(DEFAULTS);
    applyPatch(PRESETS[Number(sel.value)][1]);
    state.pinned = null;
    if (world) world.setPinned(null);
    $('pin').textContent = 'Pin this path';
    for (const id in chipEls) chipEls[id].value = '';
    changed('all');
    bowl(false);
    track('preset_loaded', { preset_name: PRESETS[Number(sel.value)][0] });
  });
}

// the one line of explanation under each panel's controls
function writeHint(panel) {
  const h = hints[panel];
  if (!h) return;
  const { c, fixed } = h.active;
  h.el.textContent = state.mode === 'challenge' && fixed
    ? 'Set by the challenge.'
    : c.note(get(state.cfg, c.key), state.cfg, state.derived);
}

// ------------------------------------------------------ where the panels sit
// Wide screens: in the corners of the play screen. Narrower ones: stacked in
// the left column, where they do not cover the pitch.
const dockQuery = window.matchMedia('(max-width: 1359px)');
const PANEL_IDS = ['ball', 'delivery', 'weather', 'pitch'];
function placePanels() {
  const docked = dockQuery.matches;
  document.body.classList.toggle('docked', docked);
  if (docked) $('hud-dock').append($('hud-ball'), $('hud-delivery'), $('hud-conditions'));
  else { $('slot-left').append($('hud-ball')); $('slot-right').append($('hud-conditions'), $('hud-delivery')); }
  for (const id of PANEL_IDS) $(`hud-${id}`).open = docked ? id === 'ball' || id === 'delivery' : true;
  if (!docked) fitPanels();
}
// One button folds every panel down to its title, for an uncluttered look at
// the flight, and brings them back.
function wireFold() {
  const btn = $('fold');
  const anyOpen = () => PANEL_IDS.some((id) => $(`hud-${id}`).open);
  const label = () => {
    const open = anyOpen();
    btn.textContent = open ? 'Hide controls' : 'Show controls';
    btn.setAttribute('aria-pressed', String(!open));
  };
  btn.addEventListener('click', () => {
    if (anyOpen()) for (const id of PANEL_IDS) $(`hud-${id}`).open = false;
    else {
      // in a challenge the weather and pitch are fixed, so they stay folded
      for (const id of PANEL_IDS) $(`hud-${id}`).open = !(state.mode === 'challenge' && (id === 'weather' || id === 'pitch'));
      fitPanels();
    }
    label();
  });
  for (const id of PANEL_IDS) $(`hud-${id}`).addEventListener('toggle', label);
  label();
}

// fold the weather and pitch away if the right-hand column is too short for everything
function fitPanels() {
  const col = $('slot-right');
  for (const id of ['pitch', 'weather']) {
    if (col.scrollHeight <= col.clientHeight + 1) break;
    $(`hud-${id}`).open = false;
  }
}

// ---------------------------------------------- turning the seam by the ball
// Dragging the close-up turns the ball under the pointer, as if it were held.
// Turning it about the vertical is the seam angle; turning it about the line
// of sight is the seam tilt. (Tipping it forward or back would be spin, which
// has its own control.)
function wireBallControl() {
  const canvas = $('ball-view');
  const ANGLE = GROUPS[1].controls[0], TILT = GROUPS[1].controls[1];
  let last = null, acc = null;
  // the pointer as a point on a unit sphere centred on the ball
  const onBall = (e) => {
    const r = canvas.getBoundingClientRect();
    const R = (r.height / 2) * 0.652; // the ball's radius on screen
    let u = (e.clientX - (r.left + r.width / 2)) / R, v = -(e.clientY - (r.top + r.height / 2)) / R;
    const d2 = u * u + v * v;
    if (d2 >= 1) { const k = 1 / Math.sqrt(d2); return [u * k, v * k, 0]; }
    return [u, v, Math.sqrt(1 - d2)];
  };
  const turn = (dAngle, dTilt) => {
    acc.angle = Math.min(ANGLE.max, Math.max(ANGLE.min, acc.angle + dAngle));
    acc.tilt = Math.min(TILT.max, Math.max(TILT.min, acc.tilt + dTilt));
    const a = Math.round(acc.angle), t = Math.round(acc.tilt);
    if (a === state.cfg.seam.angle && t === state.cfg.seam.tilt) return;
    state.cfg.seam.angle = a; state.cfg.seam.tilt = t;
    hints.ball.active = controlEls.find((e) => e.c === (Math.abs(dTilt) > Math.abs(dAngle) ? TILT : ANGLE));
    changed('seam');
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    last = onBall(e);
    acc = { angle: state.cfg.seam.angle, tilt: state.cfg.seam.tilt };
    canvas.classList.add('dragging');
    $('ball-tip').textContent = 'Drag to turn the seam';
    changed('seam'); // back to the moment of release, where the seam is as set
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const p = onBall(e);
    // the turn that carries the old point to the new one, as a rotation vector
    const wy = last[2] * p[0] - last[0] * p[2], wz = last[0] * p[1] - last[1] * p[0];
    last = p;
    turn(wy * (180 / Math.PI), wz * (180 / Math.PI));
  });
  const end = () => { last = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!step) return;
    e.preventDefault();
    acc = { angle: state.cfg.seam.angle, tilt: state.cfg.seam.tilt };
    turn(step[0], step[1]);
  });
}

// in a challenge, take the delivery and seam settings from a preset and nothing else
function loadBowlerChoices(patch) {
  state.cfg.delivery = { ...DEFAULTS.delivery, ...(patch.delivery || {}) };
  state.cfg.seam = { ...DEFAULTS.seam, ...(patch.seam || {}), condition: state.over.scenario.seamCondition };
  changed('seam');
}

function applyPatch(patch) {
  for (const group in patch) Object.assign(state.cfg[group], patch[group]);
}

// A changed setting is a new delivery that has not been bowled yet, so the ball
// goes back to the bowler's hand. Leaving the playhead at the end of the last
// flight would show the ball mid-tumble after the bounce, at a point that moves
// with every setting.
function changed(group) {
  // a ball already bowled in a challenge counts, even if its replay is cut short
  if (state.play && !state.play.committed) commitBall();
  state.dirty.sim = true;
  state.t = startTime();
  state.playing = false;
  $('bowl').textContent = bowlLabel();
  if (group === 'ball' || group === 'seam' || group === 'all') state.dirty.ball = true;
  if (group === 'pitch' || group === 'all') state.dirty.pitch = true;
  if (group === 'weather' || group === 'all') state.dirty.weather = true;
}

function syncControls() {
  const locked = state.mode === 'challenge';
  for (const { c, input, out, wrap, fixed } of controlEls) {
    input.disabled = locked && fixed;
    wrap.classList.toggle('locked', locked && fixed);
    const v = get(state.cfg, c.key);
    if (Number(input.value) !== v) input.value = v;
    input.style.setProperty('--fill', `${((v - c.min) / (c.max - c.min)) * 100}%`);
    out.textContent = c.fmt(v, state.cfg, state.derived);
  }
  // the menus of ready-made balls, days and pitches belong to free play
  for (const id in chipEls) chipEls[id].hidden = locked;
  for (const g of GROUPS) if (g.id !== 'seam') $(`gist-${g.id}`).textContent = g.gist(state.cfg, state.derived);
  for (const panel in hints) writeHint(panel);
}

// ---------------------------------------------------------------- simulation
const CURVE_SPEEDS = Array.from({ length: 51 }, (_, i) => 60 + i * 2);

function regimeOf(cs, seamYawDeg) {
  if (Math.abs(cs) < 0.015) return 'no side force';
  if (Math.abs(seamYawDeg) < 3) return 'contrast swing';
  return Math.sign(cs) === Math.sign(seamYawDeg) ? 'conventional swing' : 'reverse swing';
}

function recompute() {
  const cfg = state.cfg;
  const sim = simulate(cfg);
  state.sim = sim;
  // new settings replace the last challenge ball with a preview of the next one
  state.play = null;
  if (world && state.mode === 'challenge') world.setBatterPlan(null);
  state.duration = sim.main.samples[sim.main.samples.length - 1].t;
  state.curve = swingCurve(cfg, CURVE_SPEEDS);
  const snap0 = flowSnapshot(cfg, sim.main.samples[0]);
  state.snap0 = snap0;
  state.derived = {
    critOff: snap0.criticalSpeedOff, critLeg: snap0.criticalSpeedLeg,
    rho: sim.env.rho, restitution: sim.pitch.restitution, friction: sim.pitch.friction,
  };
  state.t = Math.min(state.t, state.duration);
  state.lastIndex = -1;
  if (world) world.setPaths(sim);
  chart.draw(state.curve, cfg.delivery.speedKmh, (p) => {
    const r = regimeOf(p.cs, cfg.seam.angle);
    return Math.abs(p.cs) < 0.015 ? 'no side force' : `toward the ${sideWord(p.cs)} side, ${r}`;
  });
  $('curve-note').textContent = curveNote(state.curve, cfg);
  const rows = $('curve-rows');
  rows.replaceChildren();
  for (const p of state.curve) {
    if (p.kmh % 10) continue;
    const tr = document.createElement('tr');
    const cells = [`${p.kmh}`, Math.abs(p.cs) < 0.005 ? '0.00' : `${Math.abs(p.cs).toFixed(2)} ${sideWord(p.cs)}`, p.cd.toFixed(2)];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    rows.appendChild(tr);
  }
  writeVerdict();
  syncControls();
}

function curveNote(curve, cfg) {
  const peak = Math.max(...curve.map((p) => Math.abs(p.cs)));
  if (peak < 0.02) return 'Almost no side force at any speed: both sides of the ball are treating the air the same way.';
  const crossings = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (a.cs * b.cs < 0 && (Math.abs(a.cs) > 0.01 || Math.abs(b.cs) > 0.01)) crossings.push(a.kmh + ((0 - a.cs) / (b.cs - a.cs)) * (b.kmh - a.kmh));
  }
  const angled = Math.abs(cfg.seam.angle) >= 3 && cfg.seam.wobble < 40;
  const first = curve.find((p) => Math.abs(p.cs) > 0.02) || curve[0];
  const name = (cs) => {
    if (!angled) return `toward the ${sideWord(cs)} side`;
    return Math.sign(cs) === Math.sign(cfg.seam.angle) ? 'the way the seam points' : 'against the seam (reverse)';
  };
  const unit = 'The number is side force divided by the dynamic pressure on the ball\'s cross-section.';
  if (!crossings.length) return `Moves ${name(first.cs)} across this whole range. ${unit}`;
  const x = Math.round(crossings[0]);
  const after = curve.find((p) => p.kmh > crossings[0] + 3) || curve[curve.length - 1];
  return `Moves ${name(first.cs)} up to about ${x} km/h, then ${name(after.cs)}. ${unit}`;
}

function writeVerdict() {
  const m = shownSim().metrics;
  const cfg = shownCfg();
  let shape;
  if (Math.abs(m.swing) < 0.025) shape = 'Straight through the air';
  else {
    const base = m.swing > 0 ? 'outswinger' : 'inswinger';
    shape = regimeOfFlight() === 'reverse swing' ? `Reverse ${base}` : base[0].toUpperCase() + base.slice(1);
  }
  // Each of the four verdict lines is written to fit on one line, so the block
  // never changes height as the wording changes.
  let fate;
  const s = m.atStumps;
  const edge = PITCH.stumpsHalfWidth + BALL.radius;
  const high = s && s.z > 1.1 ? (s.z > 1.6 ? 'head high' : 'chest high') : '';
  if (!s) fate = 'Does not carry to the stumps';
  else if (m.hitStumps) {
    const which = s.y > 0.04 ? 'off' : s.y < -0.04 ? 'leg' : 'middle';
    fate = `Hitting ${which} stump, ${cm(s.z)} cm up`;
  } else if (Math.abs(s.y) <= edge) fate = `Over the stumps by ${cm(s.z - BALL.radius - PITCH.stumpHeight)} cm`;
  else if (high) fate = s.y > 0 ? `Past off stump, ${high}` : `Down the leg side, ${high}`;
  else fate = s.y > 0 ? `Past off stump by ${cm(s.y - edge)} cm` : `Down the leg side by ${cm(-s.y - edge)} cm`;
  $('verdict-shape').textContent = shape;
  $('verdict-fate').textContent = fate;

  $('verdict-air').textContent = Math.abs(m.swing) >= 0.01
    ? `Swung ${cm(m.swing)} cm toward ${sideWord(m.swing)} before pitching.`
    : 'No swing to speak of.';
  let off;
  if (!m.pitched) off = 'Reached the stumps on the full.';
  else {
    const d = m.pitched.deviation;
    const onSeam = m.pitched.seamContact > 0.6;
    if (Math.abs(d) >= 0.15) off = `${onSeam ? 'Hit the seam and moved' : 'Moved'} ${Math.abs(d).toFixed(1)}° toward ${sideWord(d)}${onSeam ? '.' : ' after pitching.'}`;
    else off = onSeam ? 'Landed on the seam and held its line.' : 'Landed on the leather and skidded on.';
  }
  $('verdict-pitch').textContent = off;

  // In a challenge the top of the readout says what the batter did with the ball.
  // It stays quiet while the ball is in the air, so the replay is not spoiled.
  if (state.play) {
    const told = state.play.committed ? state.play.outcome.text : { headline: 'Ball in the air', detail: '', why: '' };
    $('verdict-shape').textContent = told.headline;
    $('verdict-fate').textContent = told.detail;
    $('verdict-air').textContent = told.why;
    if (!state.play.committed) $('verdict-pitch').textContent = '';
  }

  const stats = [];
  const add = (label, value, unit, wide) => stats.push({ label, value, unit, wide });
  add('Swing in the air', `${cm(m.swing)} cm`, Math.abs(m.swing) >= 0.01 ? `${Math.abs(m.swingAngle).toFixed(1)}° to ${sideWord(m.swing)}` : '');
  add('Off the pitch', m.pitched ? `${Math.abs(m.pitched.deviation).toFixed(1)}°` : 'none', m.pitched && Math.abs(m.pitched.deviation) >= 0.05 ? `to ${sideWord(m.pitched.deviation)}` : '');
  add('Movement at stumps', m.totalMovement === null ? 'n/a' : `${cm(m.totalMovement)} cm`, m.totalMovement !== null && Math.abs(m.totalMovement) >= 0.01 ? `to ${sideWord(m.totalMovement)}` : '');
  add('Height at the stumps', s ? `${cm(s.z)} cm` : 'n/a', s ? (s.z > 1.25 ? 'chest high or more' : s.z > PITCH.stumpHeight + BALL.radius ? 'over the bails' : 'stump high') : '');
  add('Pitched', m.pitched ? `${m.pitched.length.toFixed(1)} m` : 'Full toss', m.pitched ? `${m.pitched.name.toLowerCase()}, ${lineWords(m.pitched.line * 100)}` : '', true);
  add('Pace', m.pitched ? `${Math.round(m.releaseSpeed)} to ${Math.round(m.pitched.speedOut)} to ${s ? Math.round(s.speed) : '?'}` : `${Math.round(m.releaseSpeed)} to ${s ? Math.round(s.speed) : '?'}`,
    m.pitched ? 'km/h at release, off the pitch, at stumps' : 'km/h at release, at stumps', true);
  add('Reaches the batter in', m.atCrease ? `${m.atCrease.t.toFixed(2)} s` : 'n/a', '');
  add('Drag coefficient', shownSim().main.samples[0].cd.toFixed(2), 'at release');

  const dl = $('stats');
  dl.replaceChildren();
  for (const st of stats) {
    const div = document.createElement('div');
    if (st.wide) div.className = 'wide';
    const dt = document.createElement('dt'); dt.textContent = st.label;
    const dd = document.createElement('dd'); dd.textContent = st.value;
    // the detail line is always present, even when empty, so rows keep their height
    const sm = document.createElement('small'); sm.textContent = st.unit || '';
    dd.appendChild(sm);
    div.append(dt, dd);
    dl.appendChild(div);
  }
}

// which way the air pushed the ball for most of the flight before pitching
function regimeOfFlight() {
  const sim = shownSim();
  const end = sim.main.bounces[0] ? sim.main.bounces[0].index : sim.main.samples.length;
  let acc = 0;
  for (let i = 0; i < end; i++) acc += sim.main.samples[i].cs;
  const mean = acc / Math.max(1, end);
  return regimeOf(mean, shownCfg().seam.wobble < 40 ? shownCfg().seam.angle : 0);
}

// ------------------------------------------------------------------ playback
function sampleAt(t) {
  const a = shownSamples();
  let lo = 0, hi = a.length - 1;
  if (t <= a[0].t) return { ...a[0], index: 0 };
  if (t >= a[hi].t) return { ...a[hi], index: hi };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid].t <= t) lo = mid; else hi = mid;
  }
  const s0 = a[lo], s1 = a[hi];
  const k = s1.t > s0.t ? (t - s0.t) / (s1.t - s0.t) : 0;
  const p = [0, 1, 2].map((i) => s0.p[i] + (s1.p[i] - s0.p[i]) * k);
  const v = [0, 1, 2].map((i) => s0.v[i] + (s1.v[i] - s0.v[i]) * k);
  let dotq = 0;
  for (let i = 0; i < 4; i++) dotq += s0.q[i] * s1.q[i];
  const sg = dotq < 0 ? -1 : 1;
  let q = [0, 1, 2, 3].map((i) => s0.q[i] + (sg * s1.q[i] - s0.q[i]) * k);
  const ql = Math.hypot(...q);
  q = q.map((x) => x / ql);
  return { ...s0, t, p, v, q, speed: Math.hypot(...v), index: lo };
}

function bowl(newSeed = true) {
  if (newSeed) { state.cfg.seed = (state.cfg.seed || 1) + 1; state.dirty.sim = true; }
  state.t = 0;
  state.playing = true;
  $('bowl').textContent = 'Bowl';
}

function bowlLabel() {
  if (state.mode === 'challenge') return state.over && state.over.done ? 'Next challenge' : 'Bowl';
  return 'Bowl';
}

// ------------------------------------------------------------ challenge mode
const FIELD_WORDS = { slips: 'Attacking: two slips and a gully', spread: 'Defensive: boundary riders, no slips' };

function renderChallenge() {
  const on = state.mode === 'challenge';
  $('challenge').hidden = !on;
  $('scorebar').hidden = !on;
  $('about-section').hidden = on;
  document.querySelectorAll('.mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  if (!on) { $('result').hidden = true; $('flash').hidden = true; return; }
  const sc = state.over.scenario;
  $('ch-title').textContent = sc.title;
  $('ch-story').textContent = sc.story;
  const facts = [
    ['Target', sc.goal === 'chase' ? `Keep them under ${sc.need}` : 'Take a wicket'],
    ['Wickets', sc.goal === 'chase' ? `${sc.wickets} in hand` : 'One ends it'],
    ['Ball', sc.ballAge],
    ['Pitch', sc.pitchNote],
    ['Sky', sc.skyNote],
    ['Field', FIELD_WORDS[sc.field]],
  ];
  const dl = $('ch-facts');
  dl.replaceChildren();
  for (const [k, v] of facts) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  const t = state.tally;
  $('ch-tally').textContent = t.played ? `Won ${t.won} of ${t.played} this visit.` : '';
  renderScore();
}

function renderScore() {
  const over = state.over;
  $('sb-stand').textContent = standing(over);
  const left = over.scenario.wickets - over.wickets;
  $('sb-wk').textContent = over.scenario.goal === 'chase'
    ? `${over.runs} conceded, ${left} wicket${left === 1 ? '' : 's'} in hand`
    : `${over.runs} conceded`;
  const ol = $('sb-balls');
  ol.replaceChildren();
  for (const b of over.log) {
    const li = document.createElement('li');
    li.textContent = b.mark;
    li.className = b.wicket ? 'wicket' : !b.legal ? 'extra' : b.runs === 4 ? 'four' : b.runs === 6 ? 'six' : 'bowled';
    ol.appendChild(li);
  }
  for (let i = over.balls; i < 6 && !over.done; i++) ol.appendChild(document.createElement('li'));
  $('bowl').textContent = bowlLabel();
}

let flashTimer = 0;
function flash(outcome) {
  const el = $('flash');
  el.textContent = outcome.text.headline;
  el.className = `flash${outcome.result.wicket ? ' wicket' : outcome.result.boundary ? ' boundary' : ''}`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 1700);
}

function startChallenge(index) {
  state.scenarioIndex = ((index % SCENARIOS.length) + SCENARIOS.length) % SCENARIOS.length;
  const sc = SCENARIOS[state.scenarioIndex];
  state.mode = 'challenge';
  state.over = newOver(sc);
  state.rng = mulberry32((Date.now() ^ (state.scenarioIndex * 2654435761)) >>> 0);
  state.play = null;
  state.cfg = applyScenario(state.cfg, sc);
  // the weather and the pitch are fixed, so they fold away while the challenge lasts
  if (!state.foldedForChallenge) {
    state.foldedForChallenge = { weather: $('hud-weather').open, pitch: $('hud-pitch').open };
    $('hud-weather').open = false; $('hud-pitch').open = false;
  }
  for (const id in chipEls) chipEls[id].value = '';
  $('result').hidden = true;
  $('flash').hidden = true;
  if (world) world.setPeople(true, sc.field);
  renderChallenge();
  changed('all');
  track('challenge_started', { challenge_name: sc.title });
}

function leaveChallenge() {
  state.mode = 'free';
  state.over = null;
  state.play = null;
  if (state.foldedForChallenge) {
    $('hud-weather').open = state.foldedForChallenge.weather; $('hud-pitch').open = state.foldedForChallenge.pitch;
    state.foldedForChallenge = null;
  }
  if (world) world.setPeople(false);
  renderChallenge();
  changed('all');
}

// Bowl the next ball of the over: the settings as aimed, the ball as it really
// left the hand, the batter's answer, and the flight to show.
function bowlChallenge() {
  const over = state.over;
  if (over.done) { startChallenge(state.scenarioIndex + 1); return; }
  if (state.play && !state.play.committed) commitBall();
  if (over.done) return;
  if (state.dirty.sim) { recompute(); state.dirty.sim = false; }
  const rng = state.rng;
  const cfg = deliver(state.cfg, rng, Math.floor(rng() * 1e9));
  const sim = simulate(cfg);
  const outcome = faceBall(sim, cfg, situation(over), rng);
  const flight = flightAfter(sim, outcome, over.scenario.field, rng);
  state.play = { sim, cfg, outcome, ...flight, committed: false };
  state.duration = flight.endTime;
  state.t = startTime();
  state.playing = true;
  state.lastIndex = -1;
  if (world) {
    world.setPaths(
      { main: { samples: flight.samples, bounces: sim.main.bounces, hitStumps: flight.stumpsTime !== null }, ref: sim.ref, aim: state.sim.aim },
      { stumpsTime: flight.stumpsTime },
    );
    const spec = SHOTS[outcome.shot] || SHOTS.leave;
    world.setBatterPlan({
      release: flight.samples[0].t, contact: outcome.contact.t, plane: outcome.contact.p[0],
      shot: outcome.shot, kind: spec.bat, attack: spec.attack,
      bat: outcome.bat || { y: outcome.contact.p[1], z: outcome.contact.p[2] },
    });
    const end = flight.samples[flight.samples.length - 1];
    // someone takes it, or it was hit and the nearest fielders go after it
    const hit = outcome.quality && outcome.quality !== 'miss' && outcome.quality !== 'none';
    world.setFieldingPlan(
      flight.caughtBy ? { id: flight.caughtBy, start: outcome.contact.t, time: flight.endTime, point: end.p } : null,
      hit && !flight.caughtBy && flight.stumpsTime === null ? { start: outcome.contact.t, point: end.p } : null,
    );
  }
  $('flash').hidden = true;
  writeVerdict();
  track('delivery_bowled', { speed_kmh: state.cfg.delivery.speedKmh, swing_type: regimeOfFlight() });
}

// The ball is dead: put it in the book.
function commitBall() {
  const pl = state.play;
  if (!pl || pl.committed) return;
  pl.committed = true;
  recordBall(state.over, pl.outcome);
  writeVerdict();
  renderScore();
  flash(pl.outcome);
  if (state.over.done) finishOver();
}

function finishOver() {
  const over = state.over, sc = over.scenario;
  state.tally.played += 1;
  if (over.result === 'won') state.tally.won += 1;
  const spare = 6 - over.balls;
  let title, text;
  if (sc.goal === 'wicket') {
    if (over.result === 'won') { title = 'Got the wicket'; text = `Ball ${over.balls} of the over did it. ${state.play.outcome.result.detail}.`; }
    else { title = 'They survived'; text = `Six balls, no wicket, ${over.runs} run${over.runs === 1 ? '' : 's'} conceded.`; }
  } else if (over.result === 'won') {
    title = over.wickets >= sc.wickets ? 'Bowled them out' : 'Defended';
    text = over.wickets >= sc.wickets
      ? `All out, ${sc.need - over.runs} short.`
      : `They needed ${sc.need} and made ${over.runs}.`;
  } else if (over.result === 'tied') {
    title = 'A tie';
    text = `They made ${over.runs}, one short of the ${sc.need} they needed. Scores level.`;
  } else {
    title = 'They got there';
    text = spare > 0
      ? `They needed ${sc.need} and got there with ${spare} ball${spare === 1 ? '' : 's'} to spare.`
      : `They needed ${sc.need} and got there off the last ball.`;
  }
  $('res-title').textContent = title;
  $('res-text').textContent = text;
  $('result').hidden = false;
  $('ch-tally').textContent = `Won ${state.tally.won} of ${state.tally.played} this visit.`;
  $('bowl').textContent = bowlLabel();
  track('challenge_finished', { challenge_name: sc.title, challenge_result: over.result, runs_conceded: over.runs });
}

function updateFrame(force) {
  const s = sampleAt(state.t);
  if (world) world.setBall(s, state.t);
  const from = Math.min(startTime(), state.t), span = state.duration - from;
  const done = span > 0 ? (state.t - from) / span : 0;
  $('scrub').value = Math.round(done * 1000);
  $('scrub').style.setProperty('--fill', `${done * 100}%`);
  // the clock counts the ball's flight; before that the bowler is on the way in
  $('clock').textContent = `${Math.max(0, state.t).toFixed(3)} s`;

  // once the ball has left the bat the airflow picture no longer applies
  if ((force || s.index !== state.lastIndex) && !s.after) {
    state.lastIndex = s.index;
    const snap = flowSnapshot(shownCfg(), s);
    const env = shownSim().env;
    const share = (0.5 * env.rho * snap.U * snap.U * BALL.area * snap.cs) / (BALL.mass * G);
    flow.draw(snap, shownCfg().ball, share);
    const regime = regimeOf(snap.cs, snap.seamYaw);
    $('flow-note').textContent = flowNote(snap, regime);
    chart.setNow(s.speed * 3.6, snap.cs);
    const live = $('live');
    live.replaceChildren();
    const b = document.createElement('b');
    b.textContent = `${Math.round(s.speed * 3.6)} km/h`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = regime;
    live.append(b, tag);
  }
}

function flowNote(snap, regime) {
  const L = snap.left, R = snap.right;
  if (regime === 'no side force') {
    if (Math.abs(L.sep - R.sep) < 2) return 'Both sides let go of the air at the same place, so nothing pushes the ball sideways.';
    return 'The two sides are nearly balanced right now.';
  }
  const late = L.sep > R.sep ? 'off' : 'leg';
  const early = late === 'off' ? 'leg' : 'off';
  const why = regime === 'conventional swing'
    ? 'The seam has tripped the air on its side into turbulence, which clings on longer.'
    : regime === 'reverse swing'
      ? 'Both sides are turbulent now, and the seam side is the one that gives up first.'
      : 'With the seam straight, the difference comes from the leather alone.';
  return `The air stays attached longer on the ${late} side and peels away early on the ${early} side. The wake bends toward ${early} and the ball is pushed toward ${late}. ${why}`;
}

// ---------------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let force = false;
  if (state.dirty.sim) {
    recompute();
    state.dirty.sim = false;
    force = true;
  }
  if (world) {
    if (state.dirty.weather) { world.setWeather(state.cfg.weather); state.dirty.weather = false; }
    if (state.dirty.ball) { world.setBallLook(state.cfg.ball, state.cfg.seam.condition); state.dirty.ball = false; }
    if (state.dirty.pitch) { world.setPitch(state.cfg.pitch); state.dirty.pitch = false; }
  }
  if (state.playing) {
    // slow motion is for the ball's flight; once it has met the bat, pick the pace up
    const afterBat = state.play && state.t >= state.play.contactTime;
    // the run-up at its own pace, easing into the chosen speed for the delivery stride
    const k = Math.min(1, Math.max(0, (state.t + 0.34) / 0.22));
    const runIn = 1 + (state.rate - 1) * k * k * (3 - 2 * k);
    state.t += dt * (state.t < 0 ? runIn : afterBat ? Math.max(state.rate, 0.7) : state.rate);
    if (state.t >= state.duration) {
      state.t = state.duration;
      state.playing = false;
      if (state.mode === 'challenge') {
        commitBall();
        $('bowl').textContent = bowlLabel();
      } else $('bowl').textContent = 'Bowl again';
    }
    force = true;
  }
  if (force || state.needsFrame) { updateFrame(force); state.needsFrame = false; }
  if (world) world.render(dt);
  requestAnimationFrame(frame);
}

// -------------------------------------------------------------------- events
buildControls();
wireBallControl();
placePanels();
dockQuery.addEventListener('change', placePanels);
wireFold();
// a delivery the visitor chose to bowl (not the one that plays on page load)
function bowlByHand() {
  if (state.mode === 'challenge') { bowlChallenge(); return; }
  bowl(true);
  track('delivery_bowled', { speed_kmh: state.cfg.delivery.speedKmh, swing_type: state.sim ? regimeOfFlight() : 'unknown' });
}
document.querySelectorAll('.mode button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.mode === state.mode) return;
    if (b.dataset.mode === 'challenge') startChallenge(state.scenarioIndex);
    else leaveChallenge();
  });
});
$('ch-restart').addEventListener('click', () => startChallenge(state.scenarioIndex));
$('ch-next').addEventListener('click', () => startChallenge(state.scenarioIndex + 1));
$('res-again').addEventListener('click', () => startChallenge(state.scenarioIndex));
$('res-next').addEventListener('click', () => startChallenge(state.scenarioIndex + 1));
$('bowl').addEventListener('click', bowlByHand);
$('rate').addEventListener('change', (e) => { state.rate = Number(e.target.value); });
$('scrub').addEventListener('input', (e) => {
  if (state.play && !state.play.committed) commitBall(); // scrubbing a live ball still counts it
  state.playing = false;
  const from = startTime();
  state.t = from + (Number(e.target.value) / 1000) * (state.duration - from);
  state.needsFrame = true;
});
$('show-ref').addEventListener('change', (e) => world && world.showReference(e.target.checked));
if (world) world.showReference(true);
$('pin').addEventListener('click', () => {
  if (state.pinned) {
    state.pinned = null;
    $('pin').textContent = 'Pin this path';
  } else {
    state.pinned = state.sim;
    $('pin').textContent = 'Unpin path';
  }
  if (world) world.setPinned(state.pinned);
});
document.querySelectorAll('.cams button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.cams button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    if (world) world.setCamera(b.dataset.cam);
  });
});
$('reset').addEventListener('click', () => {
  $('preset').value = 0;
  if (state.mode === 'challenge') { loadBowlerChoices({}); return; }
  for (const id in chipEls) chipEls[id].value = '';
  state.cfg = clone(DEFAULTS);
  changed('all');
});
// The list of bowlers starts folded so the controls stay on screen, and remembers
// whether it was left open. Its "bowl it" links load the matching preset.
{
  const about = $('about');
  let saved = null;
  try { saved = localStorage.getItem('swinglab.about'); } catch { /* storage unavailable */ }
  // with the controls out on the play screen there is room for it to start open
  about.open = saved ? saved === 'open' : !dockQuery.matches;
  // remember only what the visitor chose, not the starting state
  about.querySelector('summary').addEventListener('click', () => {
    setTimeout(() => {
      try { localStorage.setItem('swinglab.about', about.open ? 'open' : 'closed'); } catch { /* ignore */ }
    });
  });
  about.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const sel = $('preset');
      sel.value = b.dataset.preset;
      sel.dispatchEvent(new Event('change'));
    });
  });
}
$('open-notes').addEventListener('click', () => $('notes').showModal());
$('close-notes').addEventListener('click', () => $('notes').close());
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = tag === 'BUTTON' || tag === 'SELECT' || tag === 'SUMMARY' || (tag === 'INPUT' && e.target.type !== 'range');
  if (e.code === 'Space' && !typing && !$('notes').open) {
    e.preventDefault();
    bowlByHand();
  }
});

initAnalytics({ settingsLink: $('visit-counting') });

// expose for debugging and automated checks
window.swingLab = { state, world, simulate, bowl, startChallenge, leaveChallenge };

state.rate = Number($('rate').value);
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) bowl(false);
requestAnimationFrame(frame);
