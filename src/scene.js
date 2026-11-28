// The ground, the light and the ball. Everything visual lives here; no physics.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { BALL, PITCH } from './physics.js';
import { BallSkin, ballGeometry } from './ballTexture.js';
import { Batter, Fielders, setShadowStrength } from './figures.js';

const HALF = PITCH.length / 2;
const UP = new THREE.Vector3(0, 1, 0);
// physics (x down the pitch, y to the off side, z up) -> scene (x right, y up, z toward the bowler's end)
export const toScene = (p, out = new THREE.Vector3()) => out.set(-p[1], p[2], HALF - p[0]);
const dirToScene = (d, out = new THREE.Vector3()) => out.set(-d[1], d[2], -d[0]);

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ------------------------------------------------------------------------ sky
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // always behind everything
  }
`;
const SKY_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 sunDir;
  uniform float cloud;
  uniform float time;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.02 + 17.0; a *= 0.5; }
    return s;
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = max(d.y, 0.0);
    vec3 clearSky = mix(vec3(0.62, 0.78, 0.94), vec3(0.13, 0.36, 0.78), pow(h, 0.55));
    vec3 greySky = mix(vec3(0.74, 0.77, 0.80), vec3(0.50, 0.54, 0.59), pow(h, 0.6));
    vec3 sky = mix(clearSky, greySky, smoothstep(0.35, 1.0, cloud));

    float sd = max(dot(d, sunDir), 0.0);
    float clear = 1.0 - smoothstep(0.3, 0.95, cloud);
    sky += clear * (vec3(1.0, 0.93, 0.78) * pow(sd, 600.0) * 6.0 + vec3(1.0, 0.86, 0.62) * pow(sd, 12.0) * 0.22);

    vec2 uv = d.xz / (d.y + 0.22) * 1.6 + vec2(time * 0.006, time * 0.002);
    float n = fbm(uv);
    float n2 = fbm(uv * 2.7 + 9.0);
    float thr = mix(0.78, 0.22, cloud);
    float c = smoothstep(thr, thr + 0.28, n * 0.75 + n2 * 0.25);
    c *= smoothstep(-0.02, 0.2, d.y);
    vec3 lit = mix(vec3(1.0, 0.99, 0.96), vec3(0.80, 0.82, 0.84), cloud);
    vec3 shade = mix(vec3(0.74, 0.78, 0.84), vec3(0.42, 0.45, 0.49), cloud);
    vec3 cloudCol = mix(lit, shade, smoothstep(0.35, 0.8, n2 * 0.6 + c * 0.4));
    sky = mix(sky, cloudCol, c * mix(0.85, 0.97, cloud));

    // below the horizon: haze fading into turf so reflections on the ball look grounded
    vec3 ground = mix(vec3(0.30, 0.42, 0.24), vec3(0.26, 0.34, 0.24), cloud);
    sky = mix(sky, ground, smoothstep(0.0, -0.08, d.y));
    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------- canvas paints
function paintOutfield() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = lcg(11);
  // two mowing stripes per tile
  g.fillStyle = '#3f7a3a'; g.fillRect(0, 0, S, S / 2);
  g.fillStyle = '#4a8a42'; g.fillRect(0, S / 2, S, S / 2);
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * S, y = rnd() * S;
    const l = 2 + rnd() * 5;
    const tone = rnd();
    g.strokeStyle = tone < 0.5 ? `rgba(24, 66, 24, ${0.1 + rnd() * 0.16})` : `rgba(150, 196, 110, ${0.08 + rnd() * 0.12})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 2, y + l); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  return t;
}

// Nine strips side by side; the middle one is replaced by the match pitch.
function paintSquare() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const rnd = lcg(23);
  const strip = c.width / 9;
  const tones = ['#86a862', '#93ad6b', '#8aa863', '#a3b077', '#8fae68', '#9cae70', '#88a963', '#95ad6c', '#8ba964'];
  tones.forEach((t, i) => { g.fillStyle = t; g.fillRect(i * strip, 0, strip + 1, c.height); });
  for (let i = 0; i < 30000; i++) {
    const x = rnd() * c.width, y = rnd() * c.height;
    g.strokeStyle = rnd() < 0.5 ? `rgba(40, 80, 30, ${0.05 + rnd() * 0.1})` : `rgba(220, 225, 170, ${0.04 + rnd() * 0.08})`;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5), y + 2 + rnd() * 6); g.stroke();
  }
  // soft edge into the outfield
  const edge = g.createLinearGradient(0, 0, 0, c.height);
  edge.addColorStop(0, 'rgba(74, 138, 66, 0.9)'); edge.addColorStop(0.03, 'rgba(74, 138, 66, 0)');
  edge.addColorStop(0.97, 'rgba(74, 138, 66, 0)'); edge.addColorStop(1, 'rgba(74, 138, 66, 0.9)');
  g.fillStyle = edge; g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

const PX_PER_M = 150;
const PITCH_LEN = PITCH.length + 2 * PITCH.crease;
function paintPitch(canvas, cfg) {
  const Wd = Math.round(PITCH.halfWidth * 2 * PX_PER_M);
  const Ht = Math.round(PITCH_LEN * PX_PER_M);
  if (canvas.width !== Wd) { canvas.width = Wd; canvas.height = Ht; }
  const g = canvas.getContext('2d');
  const G = cfg.grass / 100, M = cfg.moisture / 100, Wr = cfg.wear / 100, Hd = cfg.hardness / 100;
  const rnd = lcg(5);
  const X = (y) => (PITCH.halfWidth - y) * PX_PER_M; // physics y -> canvas x
  const Y = (x) => (PITCH.length + PITCH.crease - x) * PX_PER_M; // physics x -> canvas y

  // rolled clay and dead grass, greener with live grass, darker when damp
  const dry = [204, 186, 142], green = [138, 160, 92], dust = [214, 198, 160];
  let base = dry.map((v, i) => v + (green[i] - v) * G * 0.85);
  base = base.map((v, i) => v + (dust[i] - v) * Wr * 0.55 * (1 - G * 0.6));
  const damp = 1 - 0.3 * M;
  base = [base[0] * damp, base[1] * damp * (1 - 0.03 * M), base[2] * damp * (1 - 0.1 * M)];
  g.fillStyle = `rgb(${base.map(Math.round).join(',')})`;
  g.fillRect(0, 0, Wd, Ht);

  // mottling
  for (let i = 0; i < 900; i++) {
    const x = rnd() * Wd, y = rnd() * Ht, r = 12 + rnd() * 60;
    const dark = rnd() < 0.5;
    g.fillStyle = dark ? `rgba(70, 60, 30, ${0.02 + 0.04 * rnd()})` : `rgba(255, 250, 220, ${0.02 + 0.04 * rnd()})`;
    g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rnd()), rnd() * 3, 0, 7); g.fill();
  }
  // grass blades along the length of the pitch
  const blades = Math.round(14000 + 60000 * G);
  for (let i = 0; i < blades; i++) {
    const x = rnd() * Wd, y = rnd() * Ht, l = 3 + rnd() * 9;
    const live = rnd() < G;
    g.strokeStyle = live
      ? `rgba(${60 + rnd() * 40}, ${120 + rnd() * 50}, ${50 + rnd() * 30}, ${0.25 + rnd() * 0.3})`
      : `rgba(${150 + rnd() * 60}, ${135 + rnd() * 50}, ${85 + rnd() * 40}, ${0.12 + rnd() * 0.2})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 1.5, y + l); g.stroke();
  }
  // a hard pitch is rolled to a sheen down the middle
  const sheen = g.createLinearGradient(0, 0, Wd, 0);
  sheen.addColorStop(0, 'rgba(255,255,240,0)');
  sheen.addColorStop(0.5, `rgba(255,255,240,${0.1 * Hd * (1 - M)})`);
  sheen.addColorStop(1, 'rgba(255,255,240,0)');
  g.fillStyle = sheen; g.fillRect(0, 0, Wd, Ht);

  // bowlers' footmarks either side of the stumps at both ends
  if (Wr > 0.03) {
    for (const end of [0, 1]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 26; k++) {
          const px = end === 0 ? PITCH.crease + 0.2 + rnd() * 1.9 : PITCH.length - PITCH.crease - 0.2 - rnd() * 1.9;
          const py = side * (0.32 + rnd() * 0.45);
          g.fillStyle = `rgba(92, 72, 44, ${Wr * (0.06 + rnd() * 0.12)})`;
          g.beginPath();
          g.ellipse(X(py), Y(px), 10 + rnd() * 26, 16 + rnd() * 40, (rnd() - 0.5) * 0.6, 0, 7);
          g.fill();
        }
      }
    }
  }
  // cracks open up as the surface dries and wears
  const cracks = Math.round(Wr * 46 * (1 - 0.6 * M));
  g.lineCap = 'round';
  for (let i = 0; i < cracks; i++) {
    let x = rnd() * Wd, y = rnd() * Ht;
    let ang = rnd() * Math.PI * 2;
    const segs = 6 + Math.floor(rnd() * 14);
    g.strokeStyle = `rgba(52, 40, 24, ${0.35 + 0.5 * Wr})`;
    g.lineWidth = 0.8 + Wr * 2.2 * rnd();
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      ang += (rnd() - 0.5) * 1.3;
      x += Math.cos(ang) * (8 + rnd() * 22);
      y += Math.sin(ang) * (8 + rnd() * 22);
      g.lineTo(x, y);
    }
    g.stroke();
  }

  // creases
  const lw = 0.05 * PX_PER_M;
  g.fillStyle = 'rgba(250, 250, 244, 0.96)';
  const hline = (x, y0, y1) => g.fillRect(X(y1), Y(x) - lw / 2, X(y0) - X(y1), lw);
  const vline = (y, x0, x1) => g.fillRect(X(y) - lw / 2, Y(x1), lw, Y(x0) - Y(x1));
  for (const [stumps, dir] of [[0, 1], [PITCH.length, -1]]) {
    hline(stumps, -PITCH.returnCrease, PITCH.returnCrease); // bowling crease
    hline(stumps + dir * PITCH.crease, -PITCH.halfWidth, PITCH.halfWidth); // popping crease
    const a = stumps - dir * PITCH.crease, b = stumps + dir * PITCH.crease;
    vline(PITCH.returnCrease, Math.min(a, b), Math.max(a, b));
    vline(-PITCH.returnCrease, Math.min(a, b), Math.max(a, b));
  }
}

function paintCrowd() {
  const c = document.createElement('canvas');
  c.width = 4096; c.height = 512;
  const g = c.getContext('2d');
  const rnd = lcg(77);
  g.fillStyle = '#39424c'; g.fillRect(0, 0, c.width, c.height);
  // tiers of seats, most of them filled
  const shirts = ['#d9d5cb', '#bfc8d2', '#8e9fb1', '#c7ad97', '#aab79a', '#e6e2d8', '#77869a', '#9fa9b4', '#b7646a', '#5d7fa8'];
  const rows = 58;
  const rowH = c.height / rows;
  for (let row = 0; row < rows; row++) {
    const y = row * rowH;
    const upper = row < rows * 0.42;
    g.fillStyle = upper ? '#313a44' : '#3d4650';
    g.fillRect(0, y, c.width, rowH);
    g.fillStyle = 'rgba(14, 18, 24, 0.5)';
    g.fillRect(0, y + rowH - 1.6, c.width, 1.6);
    for (let x = 0; x < c.width; x += 5) {
      if (rnd() < 0.2) continue;
      g.fillStyle = shirts[Math.floor(rnd() * shirts.length)];
      g.globalAlpha = 0.28 + rnd() * 0.3;
      g.fillRect(x + rnd() * 1.5, y + 1.2 + rnd(), 2.6, rowH - 4);
    }
    g.globalAlpha = 1;
  }
  // gangways and the break between the two tiers
  for (let x = 0; x < c.width; x += 292) { g.fillStyle = '#2a323b'; g.fillRect(x, 0, 9, c.height); }
  g.fillStyle = '#1f262e'; g.fillRect(0, c.height * 0.42 - 9, c.width, 18);
  g.fillStyle = '#c9ced1'; g.fillRect(0, c.height * 0.42 - 9, c.width, 3);
  // distance haze so the crowd reads as a mass, not as noise
  g.fillStyle = 'rgba(120, 134, 148, 0.34)'; g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(5, 1);
  t.anisotropy = 16;
  return t;
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.4)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// --------------------------------------------------------------------- stumps
function buildWicket(wood) {
  const group = new THREE.Group();
  const r = 0.0178;
  const stumps = [];
  const stumpGeo = new THREE.CylinderGeometry(r, r, PITCH.stumpHeight, 20);
  stumpGeo.translate(0, PITCH.stumpHeight / 2, 0);
  for (const x of [-(PITCH.stumpsHalfWidth - r), 0, PITCH.stumpsHalfWidth - r]) {
    const m = new THREE.Mesh(stumpGeo, wood);
    m.position.set(x, 0, 0);
    m.castShadow = true;
    group.add(m);
    stumps.push(m);
  }
  const bails = [];
  const bailGeo = new THREE.CylinderGeometry(0.0085, 0.0085, 0.108, 10);
  bailGeo.rotateZ(Math.PI / 2);
  for (const x of [-0.0485, 0.0485]) {
    const m = new THREE.Mesh(bailGeo, wood);
    m.position.set(x, PITCH.stumpHeight + 0.006, 0);
    m.userData.home = m.position.clone();
    m.castShadow = true;
    group.add(m);
    bails.push(m);
  }
  return { group, stumps, bails };
}

const CAMS = {
  broadcast: { pos: [0, 6.5, HALF + 11], look: [0, 0, -4.5], fov: 24 },
  umpire: { pos: [0, 1.78, HALF + 1.6], look: [0, 0.55, -HALF], fov: 30 },
  side: { pos: [-25, 1.6, -0.8], look: [0, 3.4, -0.8], fov: 50 },
  top: { pos: [0, 31, 0.6], look: [0, 0, 0], fov: 40 },
  batter: { pos: [0.28, 1.62, -(HALF - PITCH.crease) - 0.05], look: [-0.4, 1.9, HALF - PITCH.crease], fov: 34 },
  ball: { fov: 26 },
};

export class World {
  constructor(canvas, ballCanvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(20, 1, 0.05, 1500);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.012;
    this.controls.minDistance = 0.16;
    this.controls.maxDistance = 120;
    this.camName = 'broadcast';
    this.time = 0;
    this.cloud = 0.5;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.sunDir = new THREE.Vector3(-0.5, 0.74, 0.42).normalize();
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildBall();
    this._buildPaths();
    this._buildInset(ballCanvas);
    // people appear only in challenge mode
    this.batter = new Batter();
    this.batter.group.visible = false;
    this.scene.add(this.batter.group);
    this.fielders = null;
    this.setCamera('broadcast');
    this._envDirty = true;
    this._lastEnv = -1;

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  // ---------------------------------------------------------------- building
  _buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { sunDir: { value: this.sunDir }, cloud: { value: 0.5 }, time: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    const geo = new THREE.SphereGeometry(900, 48, 24);
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    // separate scene used only to bake reflections for the ball
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(geo, this.skyMat));
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.fog = new THREE.Fog(0xb9c7d2, 120, 700);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x4d6a3c, 1.0);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff2dc, 3.0);
    sun.position.copy(this.sunDir).multiplyScalar(60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -9; sc.right = 9; sc.top = 16; sc.bottom = -16; sc.near = 10; sc.far = 120;
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 3;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  _buildGround() {
    const s = this.scene;
    const grass = new THREE.MeshStandardMaterial({ map: paintOutfield(), roughness: 1, metalness: 0 });
    grass.map.repeat.set(52, 52);
    const field = new THREE.Mesh(new THREE.CircleGeometry(420, 96), grass);
    field.rotation.x = -Math.PI / 2;
    field.receiveShadow = true;
    s.add(field);

    // the square: closer-mown turf around the pitch, with the neighbouring strips
    const sq = new THREE.Mesh(
      new THREE.PlaneGeometry(27.45, 27),
      new THREE.MeshStandardMaterial({ map: paintSquare(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    sq.rotation.x = -Math.PI / 2;
    sq.position.y = 0.004;
    sq.receiveShadow = true;
    s.add(sq);

    this.pitchCanvas = document.createElement('canvas');
    paintPitch(this.pitchCanvas, { hardness: 70, grass: 30, moisture: 15, wear: 10 });
    this.pitchTex = new THREE.CanvasTexture(this.pitchCanvas);
    this.pitchTex.colorSpace = THREE.SRGBColorSpace;
    this.pitchTex.anisotropy = 16;
    this.pitchMat = new THREE.MeshStandardMaterial({
      map: this.pitchTex, roughness: 0.92, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.halfWidth * 2, PITCH_LEN), this.pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.y = 0.008;
    pitch.receiveShadow = true;
    s.add(pitch);

    const wood = new THREE.MeshStandardMaterial({ color: 0xe6cf9c, roughness: 0.55 });
    this.wicketFar = buildWicket(wood); // batter's end
    this.wicketFar.group.position.set(0, 0.008, -HALF);
    this.wicketNear = buildWicket(wood);
    this.wicketNear.group.position.set(0, 0.008, HALF);
    s.add(this.wicketFar.group, this.wicketNear.group);

    // boundary rope, hoardings, stands, sightscreens
    const rope = new THREE.Mesh(
      new THREE.TorusGeometry(68, 0.09, 8, 160),
      new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.8 }),
    );
    rope.rotation.x = Math.PI / 2;
    rope.position.y = 0.09;
    s.add(rope);
    const boards = new THREE.Mesh(
      new THREE.CylinderGeometry(74, 74, 1.1, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x1d3c2b, roughness: 0.9, side: THREE.BackSide }),
    );
    boards.position.y = 0.55;
    s.add(boards);
    const stand = new THREE.Mesh(
      new THREE.CylinderGeometry(104, 76, 17, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: paintCrowd(), roughness: 1, side: THREE.BackSide }),
    );
    stand.position.y = 9.4;
    s.add(stand);
    const backWall = new THREE.Mesh(
      new THREE.CylinderGeometry(104.6, 104.6, 5.4, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x4a545e, roughness: 0.9, side: THREE.BackSide }),
    );
    backWall.position.y = 20.5;
    s.add(backWall);
    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(105.5, 86, 2.2, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xc9cfd0, roughness: 0.75, side: THREE.DoubleSide }),
    );
    roof.position.y = 22.2;
    s.add(roof);
    const screenMat = new THREE.MeshStandardMaterial({ color: 0xf6f7f2, roughness: 0.85 });
    for (const z of [-72.5, 72.5]) {
      const scr = new THREE.Mesh(new THREE.BoxGeometry(11, 6, 0.3), screenMat);
      scr.position.set(0, 3.2, z);
      s.add(scr);
    }
  }

  _buildBall() {
    this.skin = new BallSkin();
    this.seamBuilt = -1;
    this.ballMat = new THREE.MeshPhysicalMaterial({
      map: this.skin.colorTex,
      bumpMap: this.skin.bumpTex,
      bumpScale: 1.6,
      roughnessMap: this.skin.surfaceTex,
      roughness: 1,
      metalness: 0,
      clearcoat: 0.85,
      clearcoatMap: this.skin.surfaceTex,
      clearcoatRoughness: 0.22,
      envMapIntensity: 1.0,
    });
    this.ball = new THREE.Mesh(ballGeometry(BALL.radius, 1), this.ballMat);
    this.ball.castShadow = false;
    this.scene.add(this.ball);

    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.6,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.scene.add(this.blob);
  }

  _line(color, width, opacity) {
    const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false });
    const line = new Line2(new LineGeometry(), mat);
    line.frustumCulled = false;
    line.visible = false;
    this.scene.add(line);
    this.lineMats.push(mat);
    return line;
  }

  _buildPaths() {
    this.lineMats = [];
    this.pathGround = this._line(0x12301f, 2, 0.4);
    this.pathPinned = this._line(0xf0c24a, 3, 0.95);
    this.pathEdge = this._line(0x12301f, 6.5, 0.55);
    this.pathFull = this._line(0xffffff, 4, 0.5);
    this.pathDone = this._line(0xffffff, 4, 1);
    const refMat = new LineMaterial({ color: 0x12301f, linewidth: 1.6, transparent: true, opacity: 0.7, dashed: true, dashSize: 0.14, gapSize: 0.14, depthWrite: false });
    this.pathRef = new Line2(new LineGeometry(), refMat);
    this.pathRef.frustumCulled = false;
    this.pathRef.visible = false;
    this.scene.add(this.pathRef);
    this.lineMats.push(refMat);
    [this.pathGround, this.pathEdge, this.pathPinned, this.pathFull, this.pathDone, this.pathRef].forEach((l, i) => { l.renderOrder = i + 1; });

    // stroboscopic ball positions every 50 ms
    this.strobe = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BALL.radius, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }),
      64,
    );
    this.strobe.count = 0;
    this.strobe.frustumCulled = false;
    this.scene.add(this.strobe);

    const ringMat = new THREE.MeshBasicMaterial({ color: 0x9c1a2c, transparent: true, opacity: 0.9, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    this.bounceMark = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.085, 32), ringMat);
    this.bounceMark.rotation.x = -Math.PI / 2;
    this.bounceMark.visible = false;
    this.scene.add(this.bounceMark);

    const aimMat = new THREE.MeshBasicMaterial({ color: 0x12301f, transparent: true, opacity: 0.75, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
    this.aimMark = new THREE.Group();
    const bar = new THREE.PlaneGeometry(0.22, 0.022);
    const a = new THREE.Mesh(bar, aimMat), b = new THREE.Mesh(bar, aimMat);
    b.rotation.z = Math.PI / 2;
    this.aimMark.add(a, b);
    this.aimMark.rotation.x = -Math.PI / 2;
    this.aimMark.visible = false;
    this.scene.add(this.aimMark);
  }

  _buildInset(canvas) {
    this.inset = null;
    if (!canvas) return;
    try {
      const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      r.setPixelRatio(1);
      r.setSize(canvas.width, canvas.height, false);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xc9d6dc);
      const cam = new THREE.PerspectiveCamera(15, canvas.width / canvas.height, 0.05, 10);
      cam.position.set(0.012, 0.05, 0.42);
      cam.lookAt(0, 0, 0);
      const ball = new THREE.Mesh(this.ball.geometry, this.ballMat);
      scene.add(ball);
      const key = new THREE.DirectionalLight(0xfff4e2, 2.6);
      key.position.set(-0.6, 1, 0.9);
      const fill = new THREE.HemisphereLight(0xe6efff, 0x5a6a50, 0.9);
      scene.add(key, fill);
      this.inset = { renderer: r, scene, camera: cam, ball, key, pmrem: new THREE.PMREMGenerator(r) };
    } catch (e) {
      console.warn('Ball close-up unavailable', e);
    }
  }

  // ------------------------------------------------------------------ inputs
  setWeather(w) {
    const c = Math.min(1, Math.max(0, w.cloud / 100));
    if (Math.abs(c - this.cloud) < 1e-4 && this._weatherSet) return;
    this._weatherSet = true;
    this.cloud = c;
    this.skyMat.uniforms.cloud.value = c;
    const direct = 1 - smooth(0.25, 1, c);
    this.sun.intensity = 0.25 + 3.1 * direct;
    this.sun.color.setHex(0xfff2dc).lerp(new THREE.Color(0xe8edf2), c);
    this.hemi.intensity = 0.75 + 0.95 * c;
    this.hemi.color.setHex(0xdfeaff).lerp(new THREE.Color(0xd9dde2), c);
    this.sun.shadow.radius = 2 + 9 * c;
    this.scene.fog.color.setHex(0xb7cde0).lerp(new THREE.Color(0xb4b9be), c);
    this.scene.fog.near = 55 - 20 * c;
    this.scene.fog.far = 620 - 300 * c;
    this.renderer.toneMappingExposure = 1.0 - 0.12 * c;
    this.blob.material.opacity = 0.62 - 0.3 * c;
    setShadowStrength(0.34 - 0.16 * c);
    if (this.inset) {
      this.inset.key.intensity = 0.9 + 1.9 * direct;
      this.inset.renderer.toneMappingExposure = 1.0 - 0.1 * c;
    }
    this._envDirty = true;
  }

  setPitch(cfg) {
    paintPitch(this.pitchCanvas, cfg);
    this.pitchTex.needsUpdate = true;
    this.pitchMat.roughness = 0.95 - 0.25 * (cfg.hardness / 100) * (1 - cfg.moisture / 100) + 0.0;
  }

  setBallLook(ball, seamCondition) {
    const seam = seamCondition / 100;
    this.skin.paint(ball.wearOff / 100, ball.wearLeg / 100, seam);
    if (Math.abs(seam - this.seamBuilt) > 0.04) {
      const old = this.ball.geometry;
      const geo = ballGeometry(BALL.radius, seam);
      this.ball.geometry = geo;
      if (this.inset) this.inset.ball.geometry = geo;
      if (this.seamBuilt >= 0) old.dispose();
      this.seamBuilt = seam;
    }
  }

  _positions(samples, lift = 0) {
    const out = new Float32Array(samples.length * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < samples.length; i++) {
      toScene(samples[i].p, v);
      out[i * 3] = v.x; out[i * 3 + 1] = lift ? lift : v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  }

  _setLine(line, positions) {
    line.geometry.dispose();
    line.geometry = new LineGeometry();
    line.geometry.setPositions(positions);
    line.computeLineDistances();
    line.visible = true;
  }

  /** Show or hide the batter and a field of the given kind ('slips' or 'spread'). */
  setPeople(on, field) {
    this.batter.group.visible = !!on;
    if (this.fielders && (!on || this.fieldKind !== field)) {
      this.scene.remove(this.fielders.group);
      this.fielders = null;
    }
    if (on && !this.fielders) {
      this.fielders = new Fielders(field);
      this.fieldKind = field;
      this.scene.add(this.fielders.group);
    }
    if (!on) this.batter.setPlan(null);
    this.batter.setFirstPerson(this.camName === 'batter');
  }

  /**
   * Who goes for the ball, or null for nobody:
   * { id, start, time, point } with `point` in pitch axes, the ball arriving
   * there at `time` having passed or left the bat at `start`.
   */
  setFieldingPlan(plan) {
    if (!this.fielders) return;
    this.fielders.setPlan(plan);
    this.fielders.pose(0);
  }

  /** The stroke the batter will play, or null to stand in the stance. */
  setBatterPlan(plan) {
    this.batter.setPlan(plan);
    this.batter.pose(0);
    if (!plan) this.setFieldingPlan(null);
  }

  // opts.stumpsTime: when the stumps are broken (null for never). Without it,
  // the stumps go when the simulated ball hits them.
  setPaths(sim, opts) {
    const main = sim.main.samples;
    this._setLine(this.pathFull, this._positions(main));
    this._setLine(this.pathDone, this._positions(main));
    this._setLine(this.pathEdge, this._positions(main));
    this._setLine(this.pathGround, this._positions(main, 0.014));
    this._setLine(this.pathRef, this._positions(sim.ref.samples));
    this.pathSamples = main;

    // strobe
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    let n = 0, next = 0.05;
    for (let i = 0; i < main.length && n < 64; i++) {
      if (main[i].t >= next) {
        toScene(main[i].p, v);
        m.makeTranslation(v.x, v.y, v.z);
        this.strobe.setMatrixAt(n++, m);
        next += 0.05;
      }
    }
    this.strobe.count = n;
    this.strobe.instanceMatrix.needsUpdate = true;

    const b = sim.main.bounces[0];
    if (b && b.p[0] < PITCH.length + 1.2) {
      toScene(b.p, this.bounceMark.position);
      this.bounceMark.position.y = 0.016;
      this.bounceMark.visible = true;
    } else this.bounceMark.visible = false;

    const t = sim.aim.target;
    this.aimMark.position.set(-t[1], 0.015, HALF - t[0]);
    this.aimMark.visible = Math.abs(t[1]) < PITCH.halfWidth && t[0] < PITCH.length + PITCH.crease;
    const lastSample = sim.main.samples[sim.main.samples.length - 1];
    if (opts && 'stumpsTime' in opts) {
      this.hit = opts.stumpsTime;
      this.hitDir = opts.stumpsTime === null ? null : lastSample.v;
    } else {
      this.hit = sim.main.hitStumps ? lastSample.t : null;
      this.hitDir = sim.main.hitStumps ? lastSample.v : null;
    }
  }

  setPinned(sim) {
    if (!sim) { this.pathPinned.visible = false; return; }
    this._setLine(this.pathPinned, this._positions(sim.main.samples));
  }

  showReference(on) { this.refWanted = on; }

  /** Place the ball. state: { p, q, index, t } with p and q in physics axes. */
  setBall(state) {
    const b = this.ball;
    const prev = b.position.clone();
    toScene(state.p, b.position);
    const X = dirToScene(rotate(state.q, [1, 0, 0]));
    const Y = dirToScene(rotate(state.q, [0, 1, 0]));
    const Z = dirToScene(rotate(state.q, [0, 0, 1]));
    b.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    if (this.inset) {
      // The close-up looks along the ball's own line of flight, so the seam angle
      // it shows is the one the air sees and does not shift when the aim changes.
      const heading = state.v ? Math.atan2(state.v[1], state.v[0]) : 0;
      this.inset.ball.quaternion.setFromAxisAngle(UP, -heading).multiply(b.quaternion);
    }

    // contact shadow where the sun would put it
    const h = b.position.y;
    const k = h / this.sunDir.y;
    this.blob.position.set(b.position.x - this.sunDir.x * k, 0.02, b.position.z - this.sunDir.z * k);
    const size = BALL.radius * 2 * (1.5 + h * 0.9);
    this.blob.scale.set(size, size, 1);

    // traveled part of the path
    const segs = Math.max(0, Math.min(this.pathSamples ? this.pathSamples.length - 1 : 0, state.index));
    this.pathDone.geometry.instanceCount = segs;

    if (this.camName === 'ball') {
      const d = b.position.clone().sub(prev);
      if (d.lengthSq() < 4) this.camera.position.add(d);
      else this._placeBallCam();
      this.controls.target.copy(b.position);
    }
    this._knock(state.t);
    if (this.batter.group.visible) {
      this.batter.pose(state.t);
      if (this.fielders) this.fielders.pose(state.t);
    }
  }

  _knock(t) {
    const w = this.wicketFar;
    const tau = this.hit !== null && this.hit !== undefined ? t - this.hit : -1;
    if (tau <= 0) {
      w.stumps.forEach((s) => s.rotation.set(0, 0, 0));
      w.bails.forEach((bl) => { bl.position.copy(bl.userData.home); bl.rotation.set(0, 0, 0); });
      return;
    }
    const side = this.hitDir ? -Math.sign(this.hitDir[1] || 0.001) : 0;
    w.stumps.forEach((s, i) => {
      const a = Math.min(0.95, tau * (4.5 + i * 1.3));
      s.rotation.set(-a, 0, side * a * 0.18 * (i - 1));
    });
    w.bails.forEach((bl, i) => {
      const h = bl.userData.home;
      const vx = (i ? 1 : -1) * 0.9 + side * 0.4, vy = 2.6 + i * 0.5, vz = -3.2;
      const y = h.y + vy * tau - 4.9 * tau * tau;
      bl.position.set(h.x + vx * tau, Math.max(0.01, y), h.z + vz * tau);
      bl.rotation.set(tau * 14, tau * 9 * (i ? 1 : -1), tau * 6);
    });
  }

  _placeBallCam() {
    const p = this.ball.position;
    this.camera.position.set(p.x + 0.16, p.y + 0.12, p.z + 0.46);
    this.controls.target.copy(p);
  }

  setCamera(name) {
    this.camName = name;
    if (this.batter) this.batter.setFirstPerson(name === 'batter');
    const c = CAMS[name];
    this.camera.fov = c.fov;
    this.camera.updateProjectionMatrix();
    if (name === 'ball') this._placeBallCam();
    else {
      this.camera.position.set(...c.pos);
      this.controls.target.set(...c.look);
    }
    this.controls.update();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    for (const m of this.lineMats) m.resolution.set(w * pr, h * pr);
  }

  _bakeEnvironment() {
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 1, 2000).texture;
    if (old) old.dispose();
    if (this.inset) {
      const o2 = this.inset.scene.environment;
      this.inset.scene.environment = this.inset.pmrem.fromScene(this.envScene, 0, 1, 2000).texture;
      if (o2) o2.dispose();
    }
    this._envDirty = false;
  }

  render(dt) {
    if (!this.reducedMotion) this.time += dt;
    this.skyMat.uniforms.time.value = this.time;
    if (this._envDirty && this.time - this._lastEnv > 0.2) {
      this._bakeEnvironment();
      this._lastEnv = this.time;
    }
    // in the ball close-up the path would skewer the ball, so only the ground trace stays
    const wide = this.camName !== 'ball' && !!this.pathSamples;
    this.pathEdge.visible = this.pathFull.visible = this.pathDone.visible = this.strobe.visible = wide;
    this.pathRef.visible = wide && !!this.refWanted;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.inset) this.inset.renderer.render(this.inset.scene, this.inset.camera);
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function rotate(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
