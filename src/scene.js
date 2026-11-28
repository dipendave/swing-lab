// The ground, the light and the ball. Everything visual lives here; no physics.
//
// The light is a daylight model: a sky that scatters sunlight as air does, a
// sun whose shadows are drawn in cascades so they stay sharp near the camera
// and reach the boundary, the sky itself as the fill light, and, on machines
// that can afford it, shading where surfaces meet and a glow round the
// brightest things. All of it follows the weather.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BALL, PITCH } from './physics.js';
import { BallSkin, ballGeometry } from './ballTexture.js';
import { Batter, Bowler, NonStriker, Umpires, Fielders, setShadowStrength, loadFigures } from './figures.js';

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
  uniform float turbidity;
  uniform float disc;
  const float PI = 3.141592653589793;

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
  float layer(vec2 uv) { return fbm(uv) * 0.75 + fbm(uv * 2.7 + 9.0) * 0.25; }

  // Clear air: Preetham's daylight model, as three.js's Sky object has it.
  // Blue overhead, pale at the horizon, bright round the sun, hazier as the
  // turbidity goes up.
  const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const vec3 mieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
  float sunIntensity(float zenithCos) {
    return 1000.0 * max(0.0, 1.0 - exp(-((1.6110731556870734 - acos(clamp(zenithCos, -1.0, 1.0))) / 1.5)));
  }
  vec3 daylight(vec3 dir) {
    float sunE = sunIntensity(sunDir.y);
    vec3 betaR = totalRayleigh * 2.0;
    vec3 betaM = 0.434 * (0.2 * turbidity) * 10E-18 * mieConst * 0.005;
    float zenith = acos(max(0.0, dir.y));
    float inv = 1.0 / (cos(zenith) + 0.15 * pow(93.885 - (zenith * 180.0 / PI), -1.253));
    vec3 fex = exp(-(betaR * 8.4E3 * inv + betaM * 1.25E3 * inv));
    float c = dot(dir, sunDir);
    float rPhase = 0.05968310365946075 * (1.0 + pow(c * 0.5 + 0.5, 2.0));
    float mPhase = 0.07957747154594767 * (0.36 / pow(1.64 - 1.6 * c, 1.5));
    vec3 scatter = (betaR * rPhase + betaM * mPhase) / (betaR + betaM);
    vec3 lin = pow(sunE * scatter * (1.0 - fex), vec3(1.5));
    lin *= mix(vec3(1.0), pow(sunE * scatter * fex, vec3(0.5)), clamp(pow(1.0 - sunDir.y, 5.0), 0.0, 1.0));
    vec3 col = (lin + vec3(0.1) * fex) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    return pow(col, vec3(1.0 / 2.4));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = max(d.y, 0.0);
    vec3 above = normalize(vec3(d.x, h, d.z));
    float over = smoothstep(0.55, 1.0, cloud);
    // an overcast sky is three times as bright overhead as at the horizon
    vec3 grey = vec3(0.56, 0.59, 0.63) * (1.0 + 2.0 * h) * 0.5;
    vec3 sky = mix(daylight(above) * 0.62, grey, over);

    // one layer of cloud, lit from the sun's side and dark underneath
    vec2 uv = d.xz / (d.y + 0.22) * 1.6 + vec2(time * 0.006, time * 0.002);
    float dens = layer(uv);
    float thr = mix(0.78, 0.22, cloud);
    float c = smoothstep(thr, thr + 0.28, dens) * smoothstep(-0.02, 0.2, d.y);
    float sunward = layer(uv + normalize(sunDir.xz + vec2(1e-4)) * 0.11);
    float shade = clamp((sunward - dens) * 3.2 + 0.42, 0.0, 1.0);
    float thick = smoothstep(thr + 0.1, thr + 0.55, dens);
    vec3 lit = mix(vec3(1.5, 1.46, 1.38), vec3(0.72, 0.74, 0.78), over);
    vec3 dark = mix(vec3(0.5, 0.56, 0.66), vec3(0.33, 0.36, 0.41), over);
    vec3 cloudCol = mix(lit, dark, clamp(shade * 0.65 + thick * 0.5, 0.0, 1.0));
    float sd = max(dot(d, sunDir), 0.0);
    float open = 1.0 - smoothstep(0.3, 0.95, cloud);
    cloudCol += open * vec3(1.0, 0.9, 0.72) * pow(sd, 20.0) * (1.0 - thick) * 0.9; // silver lining
    cloudCol = mix(cloudCol, sky, exp(-h * 10.0) * 0.75); // lost in the haze low down
    sky = mix(sky, cloudCol, c * mix(0.9, 0.98, cloud));

    // the sun itself, where no cloud is in front of it
    float clearOfCloud = open * (1.0 - c);
    sky += clearOfCloud * vec3(1.0, 0.95, 0.85) * (disc * 45.0 * smoothstep(0.99993, 0.99997, sd) + 0.5 * pow(sd, 400.0));

    // below the horizon: turf, so that what the sky reflects and bounces is grounded
    vec3 ground = mix(vec3(0.115, 0.19, 0.075), vec3(0.085, 0.125, 0.065), cloud);
    sky = mix(sky, ground, smoothstep(0.0, -0.06, d.y));
    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// The last word on every frame: darken the corners a little, as a lens does.
const LENS = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.22 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = vUv - 0.5;
      gl_FragColor = vec4(c.rgb * (1.0 - amount * smoothstep(0.25, 0.95, dot(q, q) * 2.0)), c.a);
    }
  `,
};

// Turf is not one colour. It is mown in bands that look pale brushed away from
// you and dark brushed toward you, and it grows in patches.
const GRASS_VERT = /* glsl */ `
  vGroundPos = (modelMatrix * vec4(position, 1.0)).xyz;
`;
const GRASS_FRAG = /* glsl */ `
  {
    vec2 g = vGroundPos.xz;
    vec2 gi = floor(g * 0.045), gf = fract(g * 0.045);
    vec2 gu = gf * gf * (3.0 - 2.0 * gf);
    #define GH(p) fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)
    float patch1 = mix(mix(GH(gi), GH(gi + vec2(1.0, 0.0)), gu.x), mix(GH(gi + vec2(0.0, 1.0)), GH(gi + vec2(1.0, 1.0)), gu.x), gu.y);
    vec2 hi = floor(g * 0.31 + 7.0), hf = fract(g * 0.31 + 7.0);
    vec2 hu = hf * hf * (3.0 - 2.0 * hf);
    float patch2 = mix(mix(GH(hi), GH(hi + vec2(1.0, 0.0)), hu.x), mix(GH(hi + vec2(0.0, 1.0)), GH(hi + vec2(1.0, 1.0)), hu.x), hu.y);
    vec3 toEye = cameraPosition - vGroundPos;
    vec2 look = toEye.xz / max(length(toEye.xz), 0.001);
    float along = step(0.5, fract(g.y / 9.0)) * 2.0 - 1.0;
    float across = step(0.5, fract(g.x / 9.0)) * 2.0 - 1.0;
    float mown = along * look.y * 0.11 + across * look.x * 0.045;
    diffuseColor.rgb *= (1.0 + mown) * (0.9 + 0.14 * patch1 + 0.08 * patch2);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.05, 0.74), smoothstep(0.6, 0.95, patch1) * 0.3);
  }
`;

// ------------------------------------------------------------- canvas paints
function paintOutfield() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = lcg(11);
  g.fillStyle = '#44813d'; g.fillRect(0, 0, S, S);
  // blades: many, short and faint, darker ones underneath and lighter on top
  for (let i = 0; i < 90000; i++) {
    const x = rnd() * S, y = rnd() * S;
    const l = 2 + rnd() * 4;
    const light = i > 45000;
    g.strokeStyle = light ? `rgba(150, 200, 105, ${0.05 + rnd() * 0.1})` : `rgba(22, 62, 22, ${0.06 + rnd() * 0.12})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 2.4, y + l); g.stroke();
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

const TIERS = ['low', 'medium', 'high'];
const SHADOW_FAR = 170; // metres from the camera that shadows are drawn to
const MAX_PIXELS = 4.4e6;

const CAMS = {
  // from high behind the bowler's arm on a long lens, as television has it:
  // the delivery stride at the bottom of the picture, the keeper near the top
  broadcast: { pos: [0, 10, HALF + 30], look: [0, 0, -5], fov: 16 },
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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    // How much the machine is asked to do. It starts at the top and steps down
    // by itself if frames come slowly; ?gfx=high, medium or low pins it.
    const asked = new URLSearchParams(window.location.search).get('gfx');
    this.pinned = TIERS.includes(asked);
    this.tier = this.pinned ? asked : 'high';
    this.slow = 0;

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
    this.adopted = new WeakSet();
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildBall();
    this._buildPaths();
    this._buildInset(ballCanvas);
    this._buildPipeline();
    this._adopt(this.scene);
    // People appear only in challenge mode, and only once their model has
    // arrived: until then the ball is bowled at an empty crease.
    this.batter = null;
    this.fielders = null;
    this.people = { on: false, field: null, batterPlan: null, fieldingPlan: null };
    this.peopleReady = loadFigures().then(() => {
      this.batter = new Batter();
      this.bowler = new Bowler();
      this.nonStriker = new NonStriker();
      this.umpires = new Umpires();
      this.cast = [this.batter, this.bowler, this.nonStriker, this.umpires];
      for (const c of this.cast) { this.scene.add(c.group); this._adopt(c.group); }
      if (this.release) this.bowler.setRelease(this.release);
      this._castPeople();
      return true;
    }).catch((e) => { console.warn('Players unavailable', e); return false; });
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
      uniforms: { sunDir: { value: this.sunDir }, cloud: { value: 0.5 }, time: { value: 0 }, turbidity: { value: 5 }, disc: { value: 1 } },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    const geo = new THREE.SphereGeometry(900, 48, 24);
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.userData.noAO = true;
    this.scene.add(this.sky);
    // The same sky, in a scene of its own, is what lights everything from all
    // round and what the ball reflects.
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(geo, this.skyMat));
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.fog = new THREE.Fog(0xb9c7d2, 120, 700);
  }

  _buildLights() {
    // The sun. Its shadows are drawn four times over, each covering a longer
    // stretch of the view than the last, so the batter's are sharp and the
    // boundary fielders still have theirs.
    this.csm = new CSM({
      camera: this.camera, parent: this.scene, cascades: 4, maxFar: SHADOW_FAR, mode: 'custom',
      customSplitsCallback: (n, near, far, out) => { for (const d of [13, 34, 78]) out.push(d / far); out.push(1); },
      shadowMapSize: 2048, shadowBias: -0.00012, lightDirection: this.sunDir.clone().negate(),
      lightIntensity: 3, lightNear: 1, lightFar: 420, lightMargin: 120,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) l.shadow.normalBias = 0.035;
    this.sunColor = new THREE.Color(0xfff1dc);
  }

  // Every lit surface has to be told about the cascades, or it is lit by all
  // four suns at once. Called on anything added to the scene.
  _adopt(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !m.isMeshStandardMaterial || this.adopted.has(m)) continue;
        this.adopted.add(m);
        const own = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ? m.onBeforeCompile : null;
        this.csm.setupMaterial(m);
        if (own) {
          const theirs = m.onBeforeCompile;
          m.onBeforeCompile = (shader, renderer) => { theirs(shader, renderer); own(shader, renderer); };
        }
      }
    });
  }

  // The frame is drawn into a buffer first and finished from there.
  _buildPipeline() {
    const r = this.renderer;
    const composer = new EffectComposer(r, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }));
    composer.renderTarget2.samples = 4; // the one the scene is drawn into: smooth edges
    composer.addPass(new RenderPass(this.scene, this.camera));
    // shade where surfaces meet: under arms, between legs, where boots touch turf
    const ao = new GTAOPass(this.scene, this.camera, 4, 4);
    ao.updateGtaoMaterial({ radius: 0.4, distanceExponent: 1.5, thickness: 1.4, distanceFallOff: 1, scale: 1.1, samples: 12, screenSpaceRadius: false });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 2, rings: 2, samples: 12 });
    ao.blendIntensity = 0.85;
    // lines, sprites and anything see-through has no surface to shade against
    const hidden = [];
    ao.overrideVisibility = () => {
      hidden.length = 0;
      this.scene.traverse((o) => {
        if (o.visible && (o.userData.noAO || o.isPoints || o.isLine || o.isLineSegments2 || (o.material && (o.material.transparent || o.material.alphaTest > 0)))) {
          o.visible = false;
          hidden.push(o);
        }
      });
    };
    ao.restoreVisibility = () => { for (const o of hidden) o.visible = true; };
    // it is worked out at one sample per screen pixel, however dense the display
    const aoSize = ao.setSize.bind(ao);
    ao.setSize = (w, h) => { const k = Math.max(1, r.getPixelRatio()); aoSize(Math.ceil(w / k), Math.ceil(h / k)); };
    composer.addPass(ao);
    const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.14, 0.5, 1.0);
    composer.addPass(bloom);
    composer.addPass(new ShaderPass(LENS));
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.ao = ao;
    this.bloom = bloom;
  }

  _buildGround() {
    const s = this.scene;
    const grass = new THREE.MeshStandardMaterial({ map: paintOutfield(), roughness: 0.92, metalness: 0 });
    grass.map.repeat.set(120, 120);
    grass.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GRASS_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
        .replace('#include <map_fragment>', `#include <map_fragment>\n${GRASS_FRAG}`);
    };
    grass.customProgramCacheKey = () => 'turf';
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
    this.blob.userData.noAO = true;
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
      // a copy of the material: the one outside is tied to the cascaded shadows
      const ball = new THREE.Mesh(this.ball.geometry, this.ballMat.clone());
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
    const humid = Math.min(1, Math.max(0, (w.humidity ?? 60) / 100));
    if (Math.abs(c - this.cloud) < 1e-4 && Math.abs(humid - this.humid) < 1e-4 && this._weatherSet) return;
    this._weatherSet = true;
    this.cloud = c;
    this.humid = humid;
    const U = this.skyMat.uniforms;
    U.cloud.value = c;
    U.turbidity.value = 2.2 + 9 * humid * humid; // damp air is hazy air
    // how much of the sun gets through, and what colour it is when it does
    const direct = 1 - smooth(0.25, 1, c);
    const sun = this.sunColor.clone().lerp(new THREE.Color(0xe8edf2), c);
    for (const l of this.csm.lights) { l.intensity = 0.06 + 2.05 * direct; l.color.copy(sun); }
    // under cloud the sky is the only light there is, and the eye opens up to it
    this.scene.environmentIntensity = 0.42 + 0.5 * c;
    this.renderer.toneMappingExposure = 1.0;
    const haze = new THREE.Color(0xbfd3e6).lerp(new THREE.Color(0xd6dde2), humid).lerp(new THREE.Color(0xa9aeb3), smooth(0.5, 1, c));
    this.scene.fog.color.copy(haze).multiplyScalar(0.6 - 0.1 * c);
    this.scene.fog.near = 110 - 50 * humid;
    this.scene.fog.far = 2600 - 1500 * humid - 300 * c;
    this.blob.material.opacity = 0.5 - 0.22 * c;
    // The soft patch under each player stands in for the sky they block. In
    // sunshine their real shadow does most of the work.
    setShadowStrength(0.1 + 0.2 * c);
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
    this.people.on = !!on;
    this.people.field = field;
    if (!on) { this.people.batterPlan = null; this.people.fieldingPlan = null; this.people.chase = null; }
    this._castPeople();
  }

  // bring who is on the ground into line with what was asked for
  _castPeople() {
    if (!this.batter) return;
    const { on, field } = this.people;
    for (const c of this.cast) c.group.visible = on;
    if (this.fielders && (!on || this.fieldKind !== field)) {
      this.scene.remove(this.fielders.group);
      this.fielders.dispose();
      this.fielders = null;
    }
    if (on && !this.fielders) {
      this.fielders = new Fielders(field);
      this.fieldKind = field;
      this.scene.add(this.fielders.group);
      this._adopt(this.fielders.group);
    }
    this.batter.setPlan(this.people.batterPlan);
    this.batter.setFirstPerson(this.camName === 'batter');
    if (this.fielders) this.fielders.setPlan(this.people.fieldingPlan, this.people.chase);
    this._posePeople(this.lastT || 0);
  }

  // everyone, at time t on the ball's clock (it leaves the hand at 0)
  _posePeople(t) {
    if (!this.hasPeople()) return;
    const clock = this.time, ball = t > 0 ? this.ballAt : null;
    this.batter.pose(t, clock);
    this.bowler.pose(t, clock);
    this.nonStriker.pose(t, clock);
    this.umpires.pose(t, clock, ball);
    if (this.fielders) this.fielders.pose(t, clock, ball);
  }

  /** True when the players are on the ground, and so the bowler has a run-up. */
  hasPeople() { return !!(this.batter && this.people.on); }

  /**
   * Who goes for the ball, or null for nobody:
   * { id, start, time, point } with `point` in pitch axes, the ball arriving
   * there at `time` having passed or left the bat at `start`.
   */
  setFieldingPlan(plan, chase = null) {
    this.people.fieldingPlan = plan;
    this.people.chase = chase;
    if (this.fielders) this.fielders.setPlan(plan, chase);
  }

  /** The stroke the batter will play, or null to stand in the stance. */
  setBatterPlan(plan) {
    this.people.batterPlan = plan;
    if (!plan) this.setFieldingPlan(null);
    if (this.batter) this.batter.setPlan(plan);
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
    this.release = main[0].p.slice();
    if (this.bowler) this.bowler.setRelease(this.release);

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

  /**
   * Place the ball. state: { p, q, index, t } with p and q in physics axes.
   * `time` is the playhead when it is before the first sample: the bowler is
   * still running in, and the ball is in the bowler's hand.
   */
  setBall(state, time = state.t) {
    const b = this.ball;
    const prev = b.position.clone();
    this.lastT = time;
    this.ballAt = state.p;
    this._posePeople(time);
    const held = time < 0 && this.hasPeople();
    toScene(held ? this.bowler.ball() : state.p, b.position);
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
    this.csm.updateFrustums();
    if (name === 'ball') this._placeBallCam();
    else {
      this.camera.position.set(...c.pos);
      this.controls.target.set(...c.look);
    }
    this.controls.update();
  }

  // Pixels per CSS pixel: the display's own, up to two, and never so many that
  // the buffers behind a large window outgrow a laptop's graphics memory.
  _pixelRatio(w, h) {
    const cap = this.tier === 'low' ? 1.25 : this.tier === 'medium' ? 1.5 : 2;
    return Math.max(0.75, Math.min(window.devicePixelRatio || 1, cap, Math.sqrt(MAX_PIXELS / (w * h))));
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = this._pixelRatio(w, h);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.csm.updateFrustums();
    for (const m of this.lineMats) m.resolution.set(w * pr, h * pr);
  }

  /** 'high', 'medium' or 'low'. */
  setTier(tier) {
    if (!TIERS.includes(tier) || tier === this.tier) return;
    this.tier = tier;
    this.ao.enabled = tier === 'high';
    const size = tier === 'low' ? 1024 : 2048;
    for (const l of this.csm.lights) {
      if (l.shadow.mapSize.x === size) continue;
      l.shadow.mapSize.set(size, size);
      if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
    }
    this.csm.shadowMapSize = size;
    this.csm.updateFrustums();
    this.resize();
  }

  // Step down a tier when frames have been slow for a while. Never back up:
  // a machine that struggled once will struggle again.
  _govern(dt) {
    if (this.pinned || this.tier === 'low' || document.hidden) return;
    this.slow = dt > 1 / 28 ? this.slow + dt : Math.max(0, this.slow - dt * 2);
    if (this.slow > 2.5) {
      this.slow = 0;
      this.setTier(this.tier === 'high' ? 'medium' : 'low');
    }
  }

  _bakeEnvironment() {
    // without the sun's disc: the sun is a light of its own
    this.skyMat.uniforms.disc.value = 0;
    const bake = (holder, pmrem, scene) => {
      const old = holder.envTarget;
      holder.envTarget = pmrem.fromScene(this.envScene, 0, 1, 2000);
      scene.environment = holder.envTarget.texture;
      if (old) old.dispose();
    };
    bake(this, this.pmrem, this.scene);
    if (this.inset) bake(this.inset, this.inset.pmrem, this.inset.scene);
    this.skyMat.uniforms.disc.value = 1;
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
    // the players breathe and shift between balls, so they are posed every frame
    if (this.hasPeople() && !this.reducedMotion) {
      this._posePeople(this.lastT || 0);
      if ((this.lastT || 0) < 0) toScene(this.bowler.ball(), this.ball.position);
    }
    this.controls.update();
    this.csm.update();
    this._govern(dt);
    if (this.tier === 'low') this.renderer.render(this.scene, this.camera);
    else {
      // the scene always goes into the smooth-edged buffer
      this.composer.readBuffer = this.composer.renderTarget2;
      this.composer.writeBuffer = this.composer.renderTarget1;
      this.composer.render(dt);
    }
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
