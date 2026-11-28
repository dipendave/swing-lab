// The people on the ground in challenge mode: a bowler who runs in and bowls
// the ball that was set, a batter who plays the shot the batter model chose, a
// wicketkeeper and fielders who walk in, watch the ball and go for it, the
// batter at the other end, and two umpires.
//
// Where the joints are comes from pose.js. This file gives them bodies. The
// body is a real human mesh (MakeHuman's, CC0; see tools/build_figure.py) in a
// shirt, trousers and boots, bound to the sixteen bones the solver moves. The
// kit that cricket adds is rigid and rides on those bones: helmet or cap,
// gloves, pads, bat. A pose is a pure function of time, so scrubbing the
// timeline replays a stroke exactly.
import * as THREE from 'three';
import { PITCH } from './physics.js';
import { FIELDS } from './field.js';
import { BONES, frames, bindPose, batterPose, fielderPose, bowlerPose, bowlerScale, heldBall, nonStrikerPose, umpirePose } from './pose.js';

const HALF_PITCH = PITCH.length / 2;
const CREASE = PITCH.length - PITCH.crease;
// pitch axes (x down the pitch, y to the off side, z up) -> scene axes
const TO_SCENE = new THREE.Matrix4().set(
  0, -1, 0, 0,
  0, 0, 1, 0,
  -1, 0, 0, HALF_PITCH,
  0, 0, 0, 1,
);
const IDENTITY = new THREE.Matrix4();
const IDX = Object.fromEntries(BONES.map((n, i) => [n, i]));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const setFrame = (m, f) => m.set(
  f.x[0], f.y[0], f.z[0], f.o[0],
  f.x[1], f.y[1], f.z[1], f.o[1],
  f.x[2], f.y[2], f.z[2], f.o[2],
  0, 0, 0, 1,
);

// ------------------------------------------------------------------ the model
// Loaded once and shared by every figure: the meshes, the frames they are
// bound to, the materials, and the size of the head for fitting hats to.
let model = null;
let loading = null;

/** Fetch the body everyone wears. Resolves once it can be drawn. */
export function loadFigures(base = './assets/figure/') {
  if (!loading) loading = build(base);
  return loading;
}

async function build(base) {
  const get = async (file) => {
    const r = await fetch(base + file);
    if (!r.ok) throw new Error(`${file}: ${r.status}`);
    return r;
  };
  const [info, buf] = await Promise.all([get('figure.json').then((r) => r.json()), get('figure.bin').then((r) => r.arrayBuffer())]);
  const loader = new THREE.TextureLoader();
  const picture = async (file, colour = true) => {
    const t = await loader.loadAsync(base + file);
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const T = info.textures;
  const [skins, whites, whitesNormal, shoes, eyes, brows, lashes, hair] = await Promise.all([
    Promise.all(T.skin.map((f) => picture(f))), picture(T.whites), picture(T.whitesNormal, false), picture(T.shoes),
    picture(T.eyes), picture(T.brows), picture(T.lashes), picture(T.hair),
  ]);

  const geo = {};
  for (const [name, m] of Object.entries(info.meshes)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, m.position, m.vertices * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(buf, m.normal, m.vertices * 3), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, m.uv, m.vertices * 2), 2));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array(buf, m.skinIndex, m.vertices * 4), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(new Uint8Array(buf, m.skinWeight, m.vertices * 4), 4, true));
    const Index = m.index32 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new Index(buf, m.index, m.triangles * 3), 1));
    m.groups.forEach((gr, i) => g.addGroup(gr.start, gr.count, i));
    geo[name] = g;
  }

  // the frames the mesh was made in, and their inverses to bind it with
  const inverses = frames(bindPose(info.rig)).map((f) => setFrame(new THREE.Matrix4(), f).invert());

  // the head, in its own bone's axes: x to the left ear, y up, z out of the face
  const toHead = inverses[IDX.head];
  const at = (p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(toHead);
  const R = info.rig;
  const lo = at(R.skullMin), hi = at(R.skullMax);
  const box = new THREE.Box3();
  const hp = geo.hair.getAttribute('position'), v = new THREE.Vector3();
  for (let i = 0; i < hp.count; i++) box.expandByPoint(v.fromBufferAttribute(hp, i).applyMatrix4(toHead));
  const head = {
    halfW: (Math.abs(lo.x) + Math.abs(hi.x)) / 2, top: at(R.crown).y, front: Math.max(lo.z, hi.z), back: Math.min(lo.z, hi.z),
    eyeY: at(R.eyes).y, eyeZ: at(R.eyes).z, chinY: at(R.chin).y,
    hairHalfW: Math.max(Math.abs(box.min.x), Math.abs(box.max.x)), hairTop: box.max.y, hairFront: box.max.z, hairBack: box.min.z,
  };

  const cloth = { roughness: 0.9, metalness: 0 };
  const mats = {
    skin: skins.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.58, metalness: 0 })),
    whites: new THREE.MeshStandardMaterial({ map: whites, normalMap: whitesNormal, normalScale: new THREE.Vector2(0.9, 0.9), side: THREE.DoubleSide, ...cloth }),
    shoes: new THREE.MeshStandardMaterial({ map: shoes, roughness: 0.7, metalness: 0 }),
    eyes: new THREE.MeshStandardMaterial({ map: eyes, roughness: 0.12, metalness: 0 }),
    brows: new THREE.MeshStandardMaterial({ map: brows, alphaTest: 0.25, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    lashes: new THREE.MeshStandardMaterial({ map: lashes, alphaTest: 0.3, roughness: 0.8, side: THREE.DoubleSide }),
    hair: HAIR_TINTS.map((color) => new THREE.MeshStandardMaterial({ map: hair, color, alphaTest: 0.42, roughness: 0.62, side: THREE.DoubleSide })),
    // an umpire's shirt and dark trousers, out of the same cloth
    umpire: [
      new THREE.MeshStandardMaterial({ map: whites, normalMap: whitesNormal, color: 0xbfd0e0, side: THREE.DoubleSide, ...cloth }),
      new THREE.MeshStandardMaterial({ map: whites, normalMap: whitesNormal, color: 0x23262b, side: THREE.DoubleSide, ...cloth }),
    ],
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
  model = { geo, inverses, head, mats, measure: info.measure };
  return model;
}

// ------------------------------------------------------------- kit surfaces
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

const BALL_LOW = new THREE.SphereGeometry(1, 12, 8);

// --------------------------------------------------------------------- the kit
const PAD = 0xd8cfb4, GLOVE = 0xd2cfc3, TEAM = 0x143a27, HELMET = 0x18294a, STEEL = 0x9aa3aa, WILLOW = 0xdcc38c;
const KEEPER_GLOVE = 0xb24a2c, SUN_HAT = 0xece9dd;
// the one head of hair, as it grew and darkened twice
const HAIR_TINTS = [0xffffff, 0x6a5a50, 0x2e2a28];
// three skins, and the hair that goes with each
const TONES = [{ skin: 0, hair: [0, 1] }, { skin: 1, hair: [2, 1] }, { skin: 2, hair: [2, 2] }];

const kitMats = new Map();
function mat(color, roughness = 0.85, extra = {}) {
  const id = `${color}:${roughness}:${JSON.stringify(extra)}`;
  if (!kitMats.has(id)) kitMats.set(id, new THREE.MeshStandardMaterial({ color, roughness, ...extra }));
  return kitMats.get(id);
}

function mesh(geo, material, { at = [0, 0, 0], scale = [1, 1, 1], rot = null, shadow = false } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(at[0], at[1], at[2]);
  m.scale.set(scale[0], scale[1], scale[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

const geos = {};
function shared(name, make) { return geos[name] || (geos[name] = make()); }

// What is worn on the head, in the head's axes and fitted to its size.
function buildHeadgear(kind) {
  const H = model.head;
  const g = new THREE.Group();
  if (kind === 'helmet') {
    const shell = mat(HELMET, 0.32, { metalness: 0.15 });
    const rx = H.halfW + 0.017, rz = (H.front - H.back) / 2 + 0.022, ry = 0.124;
    // the bowl sits tipped back: clear of the brow in front, low on the nape behind
    const bowl = new THREE.Group();
    bowl.position.set(0, H.top + 0.018 - ry, (H.front + H.back) / 2 - 0.006);
    bowl.rotation.x = -0.26;
    const dome = shared('dome', () => new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.57));
    bowl.add(mesh(dome, shell, { scale: [rx, ry, rz], shadow: true }));
    bowl.add(mesh(BALL_LOW, shell, { at: [0, -0.014, rz + 0.018], scale: [rx * 0.78, 0.008, 0.052], rot: [0.14, 0, 0], shadow: true })); // peak
    g.add(bowl);
    // the grille: bars round the face below the eyes, held by two uprights
    const steel = mat(STEEL, 0.38, { metalness: 0.75 });
    const reach = H.front + 0.04, wide = H.halfW + 0.02, back = 0.012;
    [0.028, 0.052, 0.076, 0.1].forEach((drop, i) => {
      const bar = shared('bar', () => new THREE.TorusGeometry(1, 0.026, 6, 26, Math.PI * 1.06).rotateX(Math.PI / 2).rotateY(Math.PI * 0.03));
      const k = 1 - i * 0.035;
      g.add(mesh(bar, steel, { at: [0, H.eyeY - drop, back], scale: [wide * k, 0.105, (reach - back) * k] }));
    });
    const strut = shared('strut', () => new THREE.CylinderGeometry(0.0034, 0.0034, 1, 6));
    for (const sx of [-1, 1]) g.add(mesh(strut, steel, { at: [sx * (wide - 0.002), H.eyeY - 0.045, back + 0.012], scale: [1, 0.12, 1], rot: [0, 0, sx * 0.1] }));
    return g;
  }
  if (kind !== 'cap' && kind !== 'hat') return g;
  // a crown that clears the hair, sitting just above the eyebrows
  const rim = H.eyeY + 0.058;
  const rx = Math.max(H.halfW - 0.008, H.hairHalfW) + 0.004;
  const front = Math.max(H.front - 0.004, H.hairFront) + 0.004, back = H.hairBack - 0.004;
  const rz = (front - back) / 2, cz = (front + back) / 2, ry = H.hairTop + 0.005 - rim;
  const crown = shared('crown', () => new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2));
  if (kind === 'hat') {
    const cloth = mat(SUN_HAT, 0.92);
    g.add(mesh(crown, cloth, { at: [0, rim, cz], scale: [rx, ry, rz], shadow: true }));
    g.add(mesh(shared('brim', () => new THREE.CylinderGeometry(1, 1, 1, 32)), cloth, { at: [0, rim + 0.002, cz], scale: [rx + 0.078, 0.007, rz + 0.078], shadow: true }));
  } else {
    const cloth = mat(TEAM, 0.86);
    g.add(mesh(crown, cloth, { at: [0, rim, cz], scale: [rx, ry, rz], shadow: true }));
    g.add(mesh(BALL_LOW, cloth, { at: [0, rim + 0.006, front + 0.04], scale: [rx * 0.8, 0.006, 0.06], rot: [0.17, 0, 0], shadow: true })); // peak
  }
  return g;
}

// a glove, built round the middle of the palm with the wrist toward -y
function buildGlove(kind) {
  const g = new THREE.Group();
  if (kind === 'batting') {
    const white = mat(GLOVE, 0.8);
    g.add(mesh(BALL_LOW, white, { scale: [0.056, 0.066, 0.058], shadow: true }));
    // the padded rolls across the back of the fingers
    for (let i = 0; i < 4; i++) g.add(mesh(BALL_LOW, white, { at: [0, -0.034 + i * 0.024, 0.044], scale: [0.054, 0.014, 0.026] }));
    g.add(mesh(shared('cuff', () => new THREE.CylinderGeometry(0.041, 0.036, 0.07, 12)), mat(HELMET, 0.8), { at: [0, -0.085, 0] }));
  } else {
    const leather = mat(KEEPER_GLOVE, 0.75);
    g.add(mesh(BALL_LOW, leather, { at: [0, 0.03, 0], scale: [0.066, 0.092, 0.036], shadow: true }));
    g.add(mesh(BALL_LOW, leather, { at: [0.05, -0.005, 0.01], scale: [0.024, 0.045, 0.024] }));
    g.add(mesh(shared('cuff', () => new THREE.CylinderGeometry(0.037, 0.034, 0.06, 12)), mat(GLOVE, 0.8), { at: [0, -0.07, 0], scale: [1.15, 1.2, 1.15] }));
  }
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
   * look: { tone: 0 | 1 | 2, head: 'helmet' | 'cap' | 'hat' | 'bare',
   *         hands: 'bare' | 'batting' | 'keeping', pads, bat }
   * place: { at: [x, y], facing (radians from +x toward +y), scale } for a figure
   *        posed in its own frame, or null for one posed in pitch axes
   */
  constructor(look, place = null, variety = 0) {
    this.group = new THREE.Group();
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    this.setPlace(place);
    this.group.add(this.root);
    // roughly where the body is, so that it is not drawn when out of view
    this.bounds = new THREE.Sphere(new THREE.Vector3(0, 0, 1), 1.6);

    this.bones = BONES.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; this.root.add(b); return b; });
    this.skeleton = new THREE.Skeleton(this.bones, model.inverses.map((i) => i.clone()));
    const M = model.mats, tone = TONES[look.tone % TONES.length];
    const wear = (name, material, shadow = true) => {
      const part = new THREE.SkinnedMesh(model.geo[name], material);
      part.boundingSphere = this.bounds;
      part.castShadow = shadow;
      part.receiveShadow = shadow;
      this.root.add(part);
      part.bind(this.skeleton, IDENTITY);
      return part;
    };
    // the body's three runs of triangles: head and neck, left hand, right hand
    this.skin = M.skin[tone.skin];
    const hand = look.hands === 'bare' ? this.skin : M.hidden;
    this.body = wear('body', [this.skin, hand, hand]);
    wear('suit', look.suit === 'umpire' ? M.umpire : [M.whites, M.whites]);
    wear('shoes', M.shoes);
    this.face = [wear('eyes', M.eyes, false), wear('brows', M.brows, false), wear('lashes', M.lashes, false)];
    // a helmet leaves no room for hair to show, and would have it poking through
    if (look.head !== 'helmet') this.face.push(wear('hair', M.hair[tone.hair[variety % 2]]));

    const on = (bone, obj) => { this.bones[IDX[bone]].add(obj); return obj; };
    this.face.push(on('head', buildHeadgear(look.head)));
    for (const side of ['L', 'R']) {
      if (look.hands !== 'bare') {
        const glove = on(`hand${side}`, buildGlove(look.hands));
        if (side === 'L') glove.scale.x = -1; // thumbs on the inside
      }
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

  /** Where the figure stands, which way it faces and how big it is; null for the pitch's own axes. */
  setPlace(place) {
    const m = this.root.matrix.copy(TO_SCENE);
    if (place) {
      const s = place.scale || 1;
      m.multiply(new THREE.Matrix4().makeTranslation(place.at[0], place.at[1], 0))
        .multiply(new THREE.Matrix4().makeRotationZ(place.facing - Math.PI / 2))
        .multiply(new THREE.Matrix4().makeScale(s, s, s));
    }
  }

  /** Put the body in a solved pose from pose.js. */
  apply(pose) {
    this.bounds.center.set(pose.hipC[0], pose.hipC[1], 1);
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

  /** Seen through this figure's own eyes, its head would be in the way. */
  setHeadVisible(on) {
    for (const part of this.face) part.visible = on;
    this.body.material[0] = on ? this.skin : model.mats.hidden;
  }

  dispose() { this.skeleton.dispose(); }
}

// --------------------------------------------------------------------- batter
/** Needs loadFigures() to have resolved. */
export class Batter {
  constructor() {
    this.figure = new Figure({ tone: 1, head: 'helmet', hands: 'batting', pads: true, bat: true });
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

  pose(t, clock = 0) { this.figure.apply(batterPose(this.plan, t, clock)); }

  setFirstPerson(on) { this.figure.setHeadVisible(!on); }
}

// a point on the ground plan, in the axes of a figure placed there
function toOwn(place, p) {
  const dx = p[0] - place.at[0], dy = p[1] - place.at[1];
  const a = place.facing - Math.PI / 2, c = Math.cos(a), s = Math.sin(a), k = place.scale || 1;
  return [(dx * c + dy * s) / k, (-dx * s + dy * c) / k, (p[2] || 0) / k];
}

// --------------------------------------------------------------------- bowler
/** A right-arm fast bowler, sized to the height the ball is let go from. */
export class Bowler {
  constructor() {
    this.figure = new Figure({ tone: 0, head: 'bare', hands: 'bare' }, null, 1);
    this.group = this.figure.group;
    this.setRelease([PITCH.crease, 0.45, 2.15]);
    this.pose(-10);
  }

  /** Where the ball leaves the hand, in pitch axes. */
  setRelease(p) {
    this.scale = bowlerScale(p[2]);
    this.release = [p[0] / this.scale, p[1] / this.scale, p[2] / this.scale];
    this.figure.setPlace({ at: [0, 0], facing: Math.PI / 2, scale: this.scale });
  }

  pose(t, clock = 0) {
    this.last = bowlerPose(this.release, t, clock);
    this.figure.apply(this.last);
  }

  /** Where the ball is while it is still in the hand, in pitch axes. */
  ball() { return heldBall(this.last).map((x) => x * this.scale); }
}

// ----------------------------------------------------------------- non-striker
export class NonStriker {
  constructor() {
    this.figure = new Figure({ tone: 2, head: 'helmet', hands: 'batting', pads: true, bat: true });
    this.group = this.figure.group;
    this.pose(-10);
  }

  pose(t, clock = 0) { this.figure.apply(nonStrikerPose(t, clock)); }
}

// -------------------------------------------------------------------- umpires
export class Umpires {
  constructor() {
    this.group = new THREE.Group();
    // behind the stumps at the bowler's end, and square of the wicket on the leg side
    this.who = [
      { place: { at: [-2.1, 0], facing: 0, scale: 0.98 }, tone: 1 },
      { place: { at: [CREASE, -19], facing: Math.PI / 2, scale: 1.02 }, tone: 0 },
    ].map((u, i) => {
      const figure = new Figure({ tone: u.tone, head: 'hat', hands: 'bare', suit: 'umpire' }, u.place, i);
      this.group.add(figure.group);
      return { figure, place: u.place, who: 3.3 + i * 1.7 };
    });
    this.pose(-10);
  }

  /** ball: where the ball is in pitch axes, to follow with the eyes. */
  pose(t, clock = 0, ball = null) {
    for (const u of this.who) u.figure.apply(umpirePose(t, { clock, who: u.who, ball: ball ? toOwn(u.place, ball) : null }));
  }

  dispose() { for (const u of this.who) u.figure.dispose(); }
}

// ------------------------------------------------------------------- fielders
/** Everyone in the field for one setting. Needs loadFigures(). */
export class Fielders {
  constructor(field) {
    this.group = new THREE.Group();
    this.who = {};
    this.plans = {};
    const set = FIELDS[field] || FIELDS.slips;
    Object.keys(set).forEach((id, i) => {
      const at = set[id].at;
      const far = Math.hypot(at[0] - PITCH.length, at[1]) > 35;
      const kind = id === 'keeper' ? 'keeper' : id.startsWith('slip') || id === 'gully' ? 'close' : far ? 'deep' : 'ring';
      const place = { at, facing: Math.atan2(-at[1], CREASE - at[0]), scale: 0.95 + ((i * 7) % 5) * 0.022 };
      const figure = new Figure({
        tone: (i * 2 + 1) % 3,
        head: kind === 'deep' && i % 2 ? 'hat' : 'cap',
        hands: kind === 'keeper' ? 'keeping' : 'bare', pads: kind === 'keeper',
      }, place, i >> 1);
      this.group.add(figure.group);
      this.who[id] = { figure, kind, place, who: i * 1.31 };
    });
    this.pose(-10);
  }

  /**
   * What the field does about this ball.
   *   take   null, or { id, start, time, point }: that fielder takes the ball,
   *          which arrives at `point` (pitch axes) at `time`
   *   chase  null, or { start, point }: the ball was hit to `point` and the
   *          two nearest fielders go after it
   */
  setPlan(take, chase = null) {
    this.plans = {};
    if (take && this.who[take.id]) {
      this.plans[take.id] = { start: take.start, time: take.time, point: toOwn(this.who[take.id].place, take.point) };
    }
    // A ball stopped at the batter's feet is nobody's to run for. The keeper
    // stays at the stumps, and the close catchers go only for one near them.
    if (chase && Math.hypot(chase.point[0] - CREASE, chase.point[1]) > 6) {
      const near = Object.entries(this.who)
        .map(([id, f]) => ({ id, f, d: Math.hypot(chase.point[0] - f.place.at[0], chase.point[1] - f.place.at[1]) }))
        .filter((x) => !this.plans[x.id] && x.d > 2.5 && x.f.kind !== 'keeper' && (x.f.kind !== 'close' || x.d < 12))
        .sort((a, b) => a.d - b.d);
      for (const x of near.slice(0, 2)) {
        const own = toOwn(x.f.place, chase.point);
        this.plans[x.id] = { start: chase.start, chase: [own[0], own[1]] };
      }
    }
  }

  /** ball: where the ball is in pitch axes, for everyone to watch. */
  pose(t, clock = 0, ball = null) {
    for (const [id, f] of Object.entries(this.who)) {
      f.figure.apply(fielderPose(f.kind, this.plans[id] || null, t, { clock, who: f.who, ball: ball ? toOwn(f.place, ball) : null }));
    }
  }

  dispose() { for (const f of Object.values(this.who)) f.figure.dispose(); }
}
