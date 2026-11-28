// The people on the ground in challenge mode: a batter who plays the shot the
// batter model chose, a wicketkeeper and fielders who stand where the field is
// set and go for the ball when it comes to them.
//
// Where the joints are comes from pose.js. This file gives them bodies: one
// skinned mesh for the clothed trunk and limbs, modelled in a standing pose
// with human proportions, plus rigid kit on the bones (head and helmet or cap,
// gloves, pads, boots, bat). A pose is a pure function of time, so scrubbing
// the timeline replays a stroke exactly.
import * as THREE from 'three';
import { PITCH } from './physics.js';
import { FIELDS } from './field.js';
import { BONES, frames, restPose, batterPose, fielderPose } from './pose.js';

const HALF_PITCH = PITCH.length / 2;
const CREASE = PITCH.length - PITCH.crease;
// pitch axes (x down the pitch, y to the off side, z up) -> scene axes
const TO_SCENE = new THREE.Matrix4().set(
  0, -1, 0, 0,
  0, 0, 1, 0,
  -1, 0, 0, HALF_PITCH,
  0, 0, 0, 1,
);

const IDX = Object.fromEntries(BONES.map((n, i) => [n, i]));
const REST = frames(restPose());

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
// a point given in a bone's own frame, in the figure's frame
const out = (f, p) => [
  f.o[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * p[2],
  f.o[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * p[2],
  f.o[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * p[2],
];
const setFrame = (m, f) => m.set(
  f.x[0], f.y[0], f.z[0], f.o[0],
  f.x[1], f.y[1], f.z[1], f.o[1],
  f.x[2], f.y[2], f.z[2], f.o[2],
  0, 0, 0, 1,
);

// ------------------------------------------------------------------- surfaces
// A tube through a stack of cross-sections. Each ring is
//   { y, rx, rz, cx, cz, sq, rib, floor }
// in a frame whose y axis runs along the tube: an ellipse rx by rz centred at
// (cx, cz), squarer as sq rises above 2, optionally ribbed, and optionally cut
// off flat below z = floor. `place(ring, point)` puts a point where it belongs.
function tube(rings, segs, caps, place) {
  const pos = [], ringOf = [], idx = [], centre = [];
  rings.forEach((r, i) => {
    const n = r.sq || 2;
    for (let k = 0; k < segs; k++) {
      const th = (k / segs) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const rib = r.rib ? r.rib(th) : 1;
      const p = [
        (r.cx || 0) + Math.sign(c) * Math.abs(c) ** (2 / n) * r.rx * rib,
        r.y,
        (r.cz || 0) + Math.sign(s) * Math.abs(s) ** (2 / n) * (r.rz ?? r.rx) * rib,
      ];
      if (r.floor !== undefined && p[2] < r.floor) p[2] = r.floor;
      pos.push(place(r, p)); ringOf.push(i);
    }
    centre.push(place(r, [r.cx || 0, r.y, Math.max(r.cz || 0, r.floor ?? -Infinity)]));
  });
  const last = rings.length - 1;
  for (let i = 0; i < last; i++) {
    for (let k = 0; k < segs; k++) {
      const a = i * segs + k, b = i * segs + ((k + 1) % segs), c = a + segs, d = b + segs;
      idx.push(a, c, b, b, c, d);
    }
  }
  if (caps[0]) {
    const c0 = pos.length; pos.push(centre[0]); ringOf.push(0);
    for (let k = 0; k < segs; k++) idx.push(c0, k, (k + 1) % segs);
  }
  if (caps[1]) {
    const c1 = pos.length, L = last * segs; pos.push(centre[last]); ringOf.push(last);
    for (let k = 0; k < segs; k++) idx.push(c1, L + ((k + 1) % segs), L + k);
  }
  // make every face look outward, whichever way the frame happens to run
  const a = pos[idx[0]], b = pos[idx[1]], c = pos[idx[2]];
  if (dot(cross(sub(b, a), sub(c, a)), sub(a, centre[0])) < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  return { pos, ringOf, idx };
}

function geometryOf(data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(data.pos.flat(), 3));
  g.setIndex(data.idx);
  g.computeVertexNormals();
  return g;
}
const rigidTube = (rings, segs = 14, caps = [true, true]) => geometryOf(tube(rings, segs, caps, (r, p) => p));

const BALL = new THREE.SphereGeometry(1, 18, 12);
const BALL_LOW = new THREE.SphereGeometry(1, 12, 8);

// The clothed body, built up in the rest pose and bound to the bones.
class Skin {
  constructor() { this.pos = []; this.col = []; this.idx = []; this.bone = []; this.weight = []; }

  vertex(p, color, w) {
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(color[0], color[1], color[2]);
    for (let i = 0; i < 4; i++) {
      this.bone.push(w[i] ? IDX[w[i][0]] : 0);
      this.weight.push(w[i] ? w[i][1] : 0);
    }
  }

  // rings carry `in` (the bone whose frame they are given in), `w` (bone
  // weights, by default all on that bone) and `color`
  tube(rings, segs = 14, caps = [true, true]) {
    const base = this.pos.length / 3;
    const d = tube(rings, segs, caps, (r, p) => out(REST[IDX[r.in]], p));
    d.pos.forEach((p, i) => { const r = rings[d.ringOf[i]]; this.vertex(p, r.color, r.w || [[r.in, 1]]); });
    for (const i of d.idx) this.idx.push(base + i);
  }

  // a ball at `at` in a bone's frame, moving with that bone or with `follow`
  ball(bone, at, radius, color, follow = bone, scale = [1, 1, 1]) {
    const base = this.pos.length / 3;
    const src = BALL_LOW.getAttribute('position');
    for (let i = 0; i < src.count; i++) {
      const p = [at[0] + src.getX(i) * radius * scale[0], at[1] + src.getY(i) * radius * scale[1], at[2] + src.getZ(i) * radius * scale[2]];
      this.vertex(out(REST[IDX[bone]], p), color, [[follow, 1]]);
    }
    const ix = BALL_LOW.getIndex();
    for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.bone, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.weight, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// ------------------------------------------------------------------- the body
const WHITES = 0xc6c2b5, TROUSERS = 0xbfbaac, PAD = 0xd8cfb4, BOOT = 0xcfcdc5, SOLE = 0x2b2f33, GLOVE = 0xd2cfc3;
const TEAM = 0x143a27, HELMET = 0x18294a, STEEL = 0x9aa3aa, WILLOW = 0xdcc38c, KEEPER_GLOVE = 0xb24a2c;
const SKINS = [0xc48f6d, 0x8c5a3d, 0xdcab88, 0x6f4a33, 0xb47b58, 0xa76e4b];
const HAIRS = [0x1b1512, 0x2a1d14, 0x3b2a1c, 0x14110f];

const bodyCache = new Map();
function bodyGeometry(skinHex, sleeves) {
  const id = `${skinHex}:${sleeves}`;
  if (bodyCache.has(id)) return bodyCache.get(id);
  const s = new Skin();
  const shirt = rgb(WHITES), trou = rgb(TROUSERS), skin = rgb(skinHex);

  // trunk: seat, waist, chest and the slope up to the neck. Heights are above
  // the hip joints, in the pelvis frame; the weights pass from pelvis to waist
  // to chest so the trunk bends and twists as one piece.
  const trunkW = (h) => {
    if (h <= 0.04) return [['pelvis', 1]];
    if (h < 0.25) { const k = (h - 0.04) / 0.21; return [['pelvis', 1 - k], ['waist', k]]; }
    if (h < 0.44) { const k = (h - 0.25) / 0.19; return [['waist', 1 - k], ['chest', k]]; }
    return [['chest', 1]];
  };
  const trunk = [
    [-0.075, 0.05, 0.05, -0.012, 2], [-0.04, 0.125, 0.092, -0.014, 2.2], [0.02, 0.166, 0.115, -0.014, 2.3],
    [0.09, 0.166, 0.114, -0.008, 2.3], [0.17, 0.15, 0.102, 0, 2.3], [0.26, 0.157, 0.108, 0.006, 2.4],
    [0.36, 0.174, 0.12, 0.012, 2.5], [0.44, 0.184, 0.114, 0.008, 2.4], [0.492, 0.19, 0.098, 0, 2.2],
    [0.525, 0.15, 0.084, -0.004, 2.1], [0.552, 0.096, 0.07, -0.004, 2], [0.572, 0.064, 0.06, -0.004, 2],
  ].map(([h, rx, rz, cz, sq]) => ({ in: 'pelvis', y: h, rx, rz, cz, sq, w: trunkW(h), color: h < 0.1 ? trou : shirt }));
  // the shirt blouses over the waistband, with a line of shade where it tucks in
  const tuck = trou.map((v) => v * 0.8);
  trunk.splice(4, 0,
    { in: 'pelvis', y: 0.1, rx: 0.16, rz: 0.11, cz: -0.007, sq: 2.3, w: trunkW(0.1), color: tuck },
    { in: 'pelvis', y: 0.112, rx: 0.168, rz: 0.117, cz: -0.006, sq: 2.3, w: trunkW(0.112), color: shirt });
  s.tube(trunk, 18);

  // collar, then the neck up into the head
  s.tube([
    { in: 'chest', y: 0.05, rx: 0.068, rz: 0.066, cz: -0.004, color: shirt },
    { in: 'chest', y: 0.082, rx: 0.062, rz: 0.062, cz: -0.004, color: shirt },
  ], 14, [false, true]);
  s.tube([
    { in: 'chest', y: 0.06, rx: 0.056, rz: 0.058, cz: -0.004, color: skin },
    { in: 'head', y: -0.15, rx: 0.052, rz: 0.055, cz: -0.02, color: skin, w: [['chest', 0.5], ['head', 0.5]] },
    { in: 'head', y: -0.085, rx: 0.05, rz: 0.054, cz: -0.014, color: skin },
  ], 12, [false, false]);

  for (const side of ['L', 'R']) {
    const arm = `arm${side}`, fore = `fore${side}`, thigh = `thigh${side}`, shin = `shin${side}`;
    const long = sleeves === 'long';
    // shoulder: a yoke on the chest that the sleeve grows out of
    s.ball('chest', [(side === 'L' ? 1 : -1) * 0.138, -0.045, 0], 0.066, shirt, 'chest', [1, 0.85, 0.8]);
    s.ball(arm, [0, 0.01, 0], 0.0505, shirt);
    const hem = long ? 0.3 : 0.19;
    s.tube([
      { in: arm, y: 0.005, rx: 0.05, color: shirt }, { in: arm, y: 0.07, rx: 0.051, rz: 0.054, color: shirt },
      { in: arm, y: 0.15, rx: 0.049, rz: 0.051, color: shirt }, { in: arm, y: hem, rx: long ? 0.043 : 0.05, color: shirt },
    ], 12, [false, true]);
    if (!long) {
      s.tube([
        { in: arm, y: 0.17, rx: 0.042, rz: 0.044, color: skin }, { in: arm, y: 0.25, rx: 0.04, color: skin },
        { in: arm, y: 0.3, rx: 0.038, color: skin },
      ], 12, [false, false]);
    }
    const lower = long ? shirt : skin;
    s.ball(fore, [0, 0, 0], long ? 0.043 : 0.0385, lower);
    s.tube([
      { in: fore, y: 0, rx: long ? 0.043 : 0.038, color: lower }, { in: fore, y: 0.06, rx: long ? 0.045 : 0.043, rz: 0.04, color: lower },
      { in: fore, y: 0.17, rx: long ? 0.038 : 0.034, rz: 0.032, color: lower }, { in: fore, y: 0.228, rx: long ? 0.034 : 0.03, rz: 0.025, color: lower },
      { in: fore, y: 0.25, rx: 0.029, rz: 0.023, color: skin },
    ], 12, [false, true]);

    // seat and thigh
    s.ball(thigh, [0, 0, 0], 0.088, trou, 'pelvis');
    s.ball(thigh, [0, -0.005, -0.03], 0.086, trou, 'pelvis');
    s.tube([
      { in: thigh, y: -0.01, rx: 0.089, rz: 0.093, color: trou, w: [[thigh, 0.5], ['pelvis', 0.5]] }, { in: thigh, y: 0.1, rx: 0.085, rz: 0.089, color: trou },
      { in: thigh, y: 0.25, rx: 0.072, rz: 0.076, color: trou }, { in: thigh, y: 0.38, rx: 0.062, rz: 0.064, color: trou },
      { in: thigh, y: 0.44, rx: 0.058, rz: 0.06, color: trou },
    ], 14, [false, false]);
    // knee and the trouser leg down to its hem
    s.ball(shin, [0, 0, 0], 0.059, trou);
    s.tube([
      { in: shin, y: 0, rx: 0.058, rz: 0.06, color: trou }, { in: shin, y: 0.1, rx: 0.055, rz: 0.06, cz: -0.006, color: trou },
      { in: shin, y: 0.25, rx: 0.05, rz: 0.052, cz: -0.003, color: trou }, { in: shin, y: 0.39, rx: 0.047, color: trou },
    ], 14, [false, true]);
  }
  const g = s.geometry();
  bodyCache.set(id, g);
  return g;
}

// --------------------------------------------------------------------- the kit
const mats = new Map();
function mat(color, roughness = 0.85, extra = {}) {
  const id = `${color}:${roughness}:${JSON.stringify(extra)}`;
  if (!mats.has(id)) mats.set(id, new THREE.MeshStandardMaterial({ color, roughness, envMapIntensity: 0.4, ...extra }));
  return mats.get(id);
}
const CLOTH = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, envMapIntensity: 0.4 });

function mesh(geo, material, { at = [0, 0, 0], scale = [1, 1, 1], rot = null, shadow = false } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(at[0], at[1], at[2]);
  m.scale.set(scale[0], scale[1], scale[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  m.castShadow = shadow;
  return m;
}

const geos = {};
function shared(name, make) { return geos[name] || (geos[name] = make()); }

// head: jaw to crown, with the face on the +z side
function buildHead(skinHex, hairHex, wear) {
  const g = new THREE.Group();
  const skin = mat(skinHex, 0.7);
  const skull = shared('skull', () => rigidTube([
    { y: -0.119, rx: 0.028, rz: 0.03, cz: 0.034 }, { y: -0.102, rx: 0.049, rz: 0.057, cz: 0.022 },
    { y: -0.066, rx: 0.062, rz: 0.077, cz: 0.011 }, { y: -0.026, rx: 0.071, rz: 0.089, cz: 0.004 },
    { y: 0.02, rx: 0.075, rz: 0.095 }, { y: 0.065, rx: 0.072, rz: 0.091, cz: -0.004 },
    { y: 0.098, rx: 0.056, rz: 0.071, cz: -0.006 }, { y: 0.117, rx: 0.026, rz: 0.034, cz: -0.006 },
  ], 24));
  const head = mesh(skull, skin, { shadow: true });
  g.add(head);
  g.add(mesh(BALL_LOW, skin, { at: [0, -0.02, 0.097], scale: [0.012, 0.021, 0.015] })); // nose
  for (const sx of [-1, 1]) {
    g.add(mesh(BALL_LOW, skin, { at: [sx * 0.076, -0.008, -0.004], scale: [0.008, 0.023, 0.014] })); // ear
    g.add(mesh(BALL_LOW, mat(0x241a14, 0.5), { at: [sx * 0.029, 0.012, 0.084], scale: [0.0105, 0.0055, 0.006] })); // eye
  }
  g.add(mesh(BALL, mat(hairHex, 0.95), { at: [0, 0.03, -0.021], scale: [0.0795, 0.094, 0.094] })); // hair

  if (wear === 'helmet') {
    const shell = mat(HELMET, 0.36, { metalness: 0.15 });
    const dome = shared('dome', () => new THREE.SphereGeometry(1, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.6));
    g.add(mesh(dome, shell, { at: [0, 0.022, -0.006], scale: [0.099, 0.108, 0.119], shadow: true }));
    // ear pieces, then the peak
    for (const sx of [-1, 1]) g.add(mesh(BALL_LOW, shell, { at: [sx * 0.084, -0.02, -0.012], scale: [0.016, 0.05, 0.05] }));
    g.add(mesh(BALL_LOW, shell, { at: [0, 0.04, 0.128], scale: [0.078, 0.007, 0.046], rot: [0.2, 0, 0] }));
    // the grille: bars round the face, held by two uprights
    const steel = mat(STEEL, 0.4, { metalness: 0.7 });
    [[-0.012, 0.104], [-0.046, 0.1], [-0.082, 0.09]].forEach(([y, r], i) => {
      const bar = shared(`bar${i}`, () => new THREE.TorusGeometry(r, 0.0032, 6, 22, Math.PI * 1.06).rotateX(Math.PI / 2).rotateY(Math.PI * 0.03));
      g.add(mesh(bar, steel, { at: [0, y, 0.012] }));
    });
    const strut = shared('strut', () => new THREE.CylinderGeometry(0.003, 0.003, 0.085, 6));
    for (const sx of [-1, 1]) g.add(mesh(strut, steel, { at: [sx * 0.094, -0.045, 0.04], rot: [0, 0, sx * 0.12] }));
  } else if (wear === 'hat') {
    // wide-brimmed sun hat
    const cloth = mat(0xf3f1e7, 0.9);
    g.add(mesh(shared('crown', () => new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)), cloth, { at: [0, 0.058, -0.004], scale: [0.086, 0.07, 0.102], shadow: true }));
    g.add(mesh(shared('brim', () => new THREE.CylinderGeometry(1, 1, 1, 28)), cloth, { at: [0, 0.058, -0.004], scale: [0.165, 0.008, 0.18], shadow: true }));
  } else {
    const cloth = mat(TEAM, 0.85);
    g.add(mesh(shared('crown', () => new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)), cloth, { at: [0, 0.052, -0.004], scale: [0.083, 0.074, 0.101], shadow: true }));
    g.add(mesh(BALL_LOW, cloth, { at: [0, 0.056, 0.118], scale: [0.068, 0.006, 0.05], rot: [0.16, 0, 0] })); // peak
  }
  return g;
}

// a hand: bare, in a batting glove, or in a keeper's glove. Built round the
// middle of the grip, with the wrist toward -y.
function buildHand(kind, skinHex) {
  const g = new THREE.Group();
  if (kind === 'batting') {
    const white = mat(GLOVE, 0.8);
    g.add(mesh(BALL_LOW, white, { scale: [0.056, 0.066, 0.058], shadow: true }));
    // the padded rolls across the back of the fingers
    for (let i = 0; i < 4; i++) g.add(mesh(BALL_LOW, white, { at: [0, -0.034 + i * 0.024, 0.044], scale: [0.054, 0.014, 0.026] }));
    g.add(mesh(shared('cuff', () => new THREE.CylinderGeometry(0.041, 0.036, 0.07, 12)), mat(HELMET, 0.8), { at: [0, -0.085, 0] }));
  } else if (kind === 'keeping') {
    const leather = mat(KEEPER_GLOVE, 0.75);
    g.add(mesh(BALL_LOW, leather, { at: [0, 0.03, 0], scale: [0.066, 0.092, 0.036], shadow: true }));
    g.add(mesh(BALL_LOW, leather, { at: [0.05, -0.005, 0.01], scale: [0.024, 0.045, 0.024] }));
    g.add(mesh(shared('cuff', () => new THREE.CylinderGeometry(0.037, 0.034, 0.06, 12)), mat(GLOVE, 0.8), { at: [0, -0.07, 0], scale: [1.15, 1.2, 1.15] }));
  } else {
    const skin = mat(skinHex, 0.7);
    g.add(mesh(BALL_LOW, skin, { at: [0, 0.008, 0], scale: [0.04, 0.05, 0.02], shadow: true }));
    g.add(mesh(BALL_LOW, skin, { at: [0, 0.07, 0.012], scale: [0.036, 0.042, 0.016] })); // fingers, a little curled
    g.add(mesh(BALL_LOW, skin, { at: [0.04, 0.02, 0.012], scale: [0.013, 0.03, 0.013] })); // thumb
  }
  return g;
}

// boot, in the foot's frame: y toward the toe, z up, the sole 8 cm below the ankle
function buildBoot() {
  const g = new THREE.Group();
  const upper = shared('boot', () => rigidTube([
    { y: -0.078, rx: 0.026, rz: 0.03, cz: -0.046, floor: -0.074 }, { y: -0.055, rx: 0.04, rz: 0.046, cz: -0.036, floor: -0.074 },
    { y: -0.005, rx: 0.046, rz: 0.056, cz: -0.026, floor: -0.074 }, { y: 0.05, rx: 0.047, rz: 0.04, cz: -0.04, floor: -0.074 },
    { y: 0.12, rx: 0.05, rz: 0.03, cz: -0.05, floor: -0.074 }, { y: 0.175, rx: 0.043, rz: 0.024, cz: -0.055, floor: -0.074 },
    { y: 0.2, rx: 0.024, rz: 0.015, cz: -0.061, floor: -0.074 },
  ], 14));
  g.add(mesh(upper, mat(BOOT, 0.7), { shadow: true }));
  const sole = shared('sole', () => new THREE.BoxGeometry(0.086, 0.262, 0.012));
  g.add(mesh(sole, mat(SOLE, 0.9), { at: [0, 0.062, -0.076] }));
  return g;
}

// batting pad, in the shin's frame: y from the knee down to the ankle, z forward
function buildPad() {
  const ribs = (th) => (Math.sin(th) > 0.15 ? 1 + 0.06 * Math.cos(9 * (th - Math.PI / 2)) : 1);
  const geo = shared('pad', () => rigidTube([
    { y: -0.135, rx: 0.048, rz: 0.024, cz: 0.05, sq: 2.6 }, { y: -0.12, rx: 0.06, rz: 0.032, cz: 0.05, sq: 2.6 },
    { y: -0.05, rx: 0.069, rz: 0.038, cz: 0.047, sq: 2.6 }, { y: -0.03, rx: 0.074, rz: 0.049, cz: 0.045, sq: 2.4 },
    { y: -0.008, rx: 0.07, rz: 0.04, cz: 0.045, sq: 2.4 }, { y: 0.014, rx: 0.076, rz: 0.052, cz: 0.044, sq: 2.4 },
    { y: 0.038, rx: 0.07, rz: 0.04, cz: 0.044, sq: 2.4 }, { y: 0.06, rx: 0.075, rz: 0.05, cz: 0.043, sq: 2.4 },
    { y: 0.085, rx: 0.071, rz: 0.043, cz: 0.04, sq: 2.6, rib: ribs }, { y: 0.22, rx: 0.068, rz: 0.042, cz: 0.036, sq: 2.6, rib: ribs },
    { y: 0.36, rx: 0.061, rz: 0.04, cz: 0.03, sq: 2.6, rib: ribs }, { y: 0.415, rx: 0.058, rz: 0.046, cz: 0.036, sq: 2.4 },
    { y: 0.43, rx: 0.05, rz: 0.038, cz: 0.036, sq: 2.4 },
  ], 36));
  return mesh(geo, mat(PAD, 0.72), { shadow: true });
}

// the bat hangs from the top of its handle along -y, its flat face toward +z
function buildBat() {
  const g = new THREE.Group();
  const handle = shared('handle', () => new THREE.CylinderGeometry(0.0165, 0.0165, 0.3, 12).translate(0, -0.15, 0));
  g.add(mesh(handle, mat(0x8f1a2b, 0.9)));
  const blade = shared('blade', () => {
    // each section: half-width, thickness at the edges, depth of the spine
    const sections = [[-0.272, 0.02, 0.012, 0.018], [-0.31, 0.054, 0.013, 0.023], [-0.6, 0.054, 0.016, 0.048],
      [-0.74, 0.054, 0.02, 0.058], [-0.83, 0.053, 0.014, 0.034], [-0.86, 0.045, 0.008, 0.016]];
    const pos = [], idx = [];
    sections.forEach(([y, w, e, sp]) => pos.push([-w, y, 0.007], [w, y, 0.007], [w, y, -e], [0, y, -sp], [-w, y, -e]));
    for (let i = 0; i < sections.length - 1; i++) {
      for (let k = 0; k < 5; k++) {
        const a = i * 5 + k, b = i * 5 + ((k + 1) % 5), c = a + 5, d = b + 5;
        idx.push(a, c, b, b, c, d);
      }
    }
    const L = (sections.length - 1) * 5;
    idx.push(0, 1, 2, 0, 2, 3, 0, 3, 4, L, L + 2, L + 1, L, L + 3, L + 2, L, L + 4, L + 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos.flat(), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  });
  g.add(mesh(blade, mat(WILLOW, 0.6, { flatShading: true }), { shadow: true }));
  return g;
}

// soft shadow on the grass under a figure; its strength follows the sun
const shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});
let shadowTex = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}
/** How dark the soft shadows under the figures are, 0 to 1. */
export function setShadowStrength(x) { shadowMat.opacity = x; }

// ---------------------------------------------------------------------- figure
const SCRATCH = new THREE.Vector3();

class Figure {
  /**
   * look: { skin, hair, sleeves: 'short' | 'long', head: 'helmet' | 'cap' | 'hat',
   *         hands: 'bare' | 'batting' | 'keeping', pads, bat }
   * place: { at: [x, y], facing (radians from +x toward +y), scale } for a figure
   *        posed in its own frame, or null for one posed in pitch axes
   */
  constructor(look, place = null) {
    this.group = new THREE.Group();
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    const m = this.root.matrix.copy(TO_SCENE);
    if (place) {
      const s = place.scale || 1;
      m.multiply(new THREE.Matrix4().makeTranslation(place.at[0], place.at[1], 0))
        .multiply(new THREE.Matrix4().makeRotationZ(place.facing - Math.PI / 2))
        .multiply(new THREE.Matrix4().makeScale(s, s, s));
    }
    this.group.add(this.root);

    this.bones = BONES.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; this.root.add(b); return b; });
    const inverses = REST.map((f) => setFrame(new THREE.Matrix4(), f).invert());
    this.body = new THREE.SkinnedMesh(bodyGeometry(look.skin, look.sleeves), CLOTH);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.body.frustumCulled = false;
    this.root.add(this.body);
    this.body.bind(new THREE.Skeleton(this.bones, inverses), new THREE.Matrix4());

    const on = (bone, obj) => { this.bones[IDX[bone]].add(obj); return obj; };
    this.head = on('head', buildHead(look.skin, look.hair, look.head));
    for (const side of ['L', 'R']) {
      const hand = on(`hand${side}`, buildHand(look.hands, look.skin));
      if (side === 'L') hand.scale.x = -1; // thumbs on the inside
      on(`foot${side}`, buildBoot());
      if (look.pads) on(`shin${side}`, buildPad());
    }
    this.bat = null;
    if (look.bat) { this.bat = buildBat(); this.bat.matrixAutoUpdate = false; this.root.add(this.bat); }

    this.shadow = new THREE.Mesh(shared('shadow', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), shadowMat);
    if (!shadowMat.map) shadowMat.map = shadowTexture();
    this.shadow.scale.set(1.15, 1, 0.95);
    this.shadow.renderOrder = 1;
    this.group.add(this.shadow);
  }

  /** Put the body in a solved pose from pose.js. */
  apply(pose) {
    const fs = frames(pose);
    for (let i = 0; i < fs.length; i++) setFrame(this.bones[i].matrix, fs[i]);
    if (this.bat && pose.bat) {
      // y up the handle, z (the face) toward the bowler as far as the bat's line allows
      const d = pose.bat.dir, up = [-d[0], -d[1], -d[2]];
      let face = sub([-1, 0, 0], [d[0] * -d[0], d[1] * -d[0], d[2] * -d[0]]);
      if (Math.hypot(face[0], face[1], face[2]) < 0.05) face = [0, 1, 0];
      const x = cross(up, face), xl = Math.hypot(x[0], x[1], x[2]);
      const xs = [x[0] / xl, x[1] / xl, x[2] / xl];
      setFrame(this.bat.matrix, { o: pose.bat.top, x: xs, y: up, z: cross(xs, up) });
    }
    this.root.updateMatrixWorld(true);
    SCRATCH.set(pose.hipC[0], pose.hipC[1], 0).applyMatrix4(this.root.matrix);
    this.shadow.position.set(SCRATCH.x, 0.022, SCRATCH.z);
  }
}

// --------------------------------------------------------------------- batter
export class Batter {
  constructor() {
    this.figure = new Figure({ skin: SKINS[0], hair: HAIRS[0], sleeves: 'short', head: 'helmet', hands: 'batting', pads: true, bat: true });
    this.group = this.figure.group;
    this.plan = null;
    this.pose(0);
  }

  /**
   * plan: null for an idle stance, or
   *   { release, contact, plane, shot, kind: 'vertical'|'horizontal'|'none',
   *     attack, bat: { y, z } }  times in seconds, distances in pitch axes
   */
  setPlan(plan) { this.plan = plan; }

  pose(t) { this.figure.apply(batterPose(this.plan, t)); }

  /** Seen through the batter's own eyes, the head would be in the way. */
  setFirstPerson(on) { this.figure.head.visible = !on; }
}

// ------------------------------------------------------------------- fielders
/** Everyone in the field for one setting, with the one going for the ball animated. */
export class Fielders {
  constructor(field) {
    this.group = new THREE.Group();
    this.who = {};
    this.plan = null;
    const set = FIELDS[field] || FIELDS.slips;
    Object.keys(set).forEach((id, i) => {
      const at = set[id].at;
      const far = Math.hypot(at[0] - PITCH.length, at[1]) > 35;
      const kind = id === 'keeper' ? 'keeper' : id.startsWith('slip') || id === 'gully' ? 'close' : far ? 'deep' : 'ring';
      const place = { at, facing: Math.atan2(-at[1], CREASE - at[0]), scale: 0.95 + ((i * 7) % 5) * 0.022 };
      const figure = new Figure({
        skin: SKINS[(i * 2 + 1) % SKINS.length], hair: HAIRS[i % HAIRS.length],
        sleeves: i % 3 === 1 ? 'long' : 'short',
        head: kind === 'deep' && i % 2 ? 'hat' : 'cap',
        hands: kind === 'keeper' ? 'keeping' : 'bare', pads: kind === 'keeper',
      }, place);
      figure.apply(fielderPose(kind, null, 0));
      this.group.add(figure.group);
      this.who[id] = { figure, kind, place };
    });
  }

  /** plan: null, or { id, start, time, point }: `point` in pitch axes. */
  setPlan(plan) {
    if (this.plan && (!plan || plan.id !== this.plan.id)) {
      const f = this.who[this.plan.id];
      f.figure.apply(fielderPose(f.kind, null, 0));
    }
    this.plan = null;
    if (!plan || !this.who[plan.id]) return;
    // the point in the fielder's own frame
    const { place } = this.who[plan.id];
    const dx = plan.point[0] - place.at[0], dy = plan.point[1] - place.at[1];
    const a = place.facing - Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
    this.plan = {
      id: plan.id, start: plan.start, time: plan.time,
      point: [(dx * c + dy * s) / place.scale, (-dx * s + dy * c) / place.scale, plan.point[2] / place.scale],
    };
  }

  pose(t) {
    if (!this.plan) return;
    const f = this.who[this.plan.id];
    f.figure.apply(fielderPose(f.kind, this.plan, t));
  }
}
