// Procedural cricket ball: colour, bump and surface maps painted on canvases.
//
// The texture is equirectangular with the seam on the equator, so the top half
// of the canvas is the hemisphere the seam normal points into (the off-side
// half at release) and the bottom half is the other one. Leather detail comes
// from 3D noise sampled on the sphere, so nothing pinches at the two poles,
// which sit in the middle of each face.
import * as THREE from 'three';

const W = 1024;
const H = 512;

// ------------------------------------------------------------- value noise 3D
const PERM = new Uint8Array(512);
{
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t) => t * t * (3 - 2 * t);
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const A = PERM[X] + Y, B = PERM[X + 1] + Y;
  const AA = PERM[A] + Z, AB = PERM[A + 1] + Z, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  const h = (i) => PERM[i] / 255;
  const x00 = h(AA) + (h(BA) - h(AA)) * u;
  const x10 = h(AB) + (h(BB) - h(AB)) * u;
  const x01 = h(AA + 1) + (h(BA + 1) - h(AA + 1)) * u;
  const x11 = h(AB + 1) + (h(BB + 1) - h(AB + 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
function fbm(x, y, z, oct) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * noise3(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

// noise fields are computed once; wear sliders only recombine them
let fields = null;
function buildFields() {
  const n = W * H;
  const grain = new Float32Array(n);
  const scuff = new Float32Array(n);
  const blotch = new Float32Array(n);
  for (let py = 0; py < H; py++) {
    const lat = Math.PI / 2 - (Math.PI * (py + 0.5)) / H;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let px = 0; px < W; px++) {
      const lon = (2 * Math.PI * (px + 0.5)) / W;
      const x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
      const i = py * W + px;
      grain[i] = 0.6 * noise3(x * 85 + 3, y * 85 + 7, z * 85 + 11) + 0.4 * noise3(x * 190, y * 190, z * 190);
      scuff[i] = fbm(x * 5.5 + 19, y * 5.5 + 5, z * 5.5 + 2, 4);
      blotch[i] = fbm(x * 2.1 + 40, y * 2.1 + 31, z * 2.1 + 9, 2);
    }
  }
  // stretch the scuff field to cover 0..1 so the wear threshold behaves
  let lo = 1, hi = 0;
  for (let i = 0; i < n; i++) { if (scuff[i] < lo) lo = scuff[i]; if (scuff[i] > hi) hi = scuff[i]; }
  for (let i = 0; i < n; i++) scuff[i] = (scuff[i] - lo) / (hi - lo);
  fields = { grain, scuff, blotch };
}

const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class BallSkin {
  constructor() {
    if (!fields) buildFields();
    this.color = document.createElement('canvas');
    this.bump = document.createElement('canvas');
    this.surface = document.createElement('canvas'); // R = lacquer (clearcoat), G = roughness
    for (const c of [this.color, this.bump, this.surface]) { c.width = W; c.height = H; }
    this.colorTex = new THREE.CanvasTexture(this.color);
    this.colorTex.colorSpace = THREE.SRGBColorSpace;
    this.bumpTex = new THREE.CanvasTexture(this.bump);
    this.surfaceTex = new THREE.CanvasTexture(this.surface);
    for (const t of [this.colorTex, this.bumpTex, this.surfaceTex]) {
      t.wrapS = THREE.RepeatWrapping;
      t.anisotropy = 8;
    }
    this._img = {
      color: new ImageData(W, H),
      bump: new ImageData(W, H),
      surface: new ImageData(W, H),
    };
  }

  /** wearA / wearB: 0..1 for the off-side and leg-side halves. seam: 0..1 prominence. */
  paint(wearA, wearB, seam) {
    const { grain, scuff, blotch } = fields;
    const cd = this._img.color.data, bd = this._img.bump.data, sd = this._img.surface.data;
    for (let py = 0; py < H; py++) {
      const w = py < H / 2 ? wearA : wearB;
      const thr = 1 - 1.12 * w;
      const dull = 0.65 * w;
      for (let px = 0; px < W; px++) {
        const i = py * W + px, o = i * 4;
        const g = grain[i], b = blotch[i];
        const m = w > 0.01 ? sstep(thr, thr + 0.28, scuff[i]) * Math.min(1, w * 4) : 0;
        // lacquered cherry -> dull, darker leather -> pale scuffed fibre
        const shade = 0.9 + 0.2 * b;
        let r = mix(138, 104, dull) * shade;
        let gg = mix(12, 30, dull) * shade;
        let bb = mix(22, 30, dull) * shade;
        const fib = 0.78 + 0.5 * g;
        r = mix(r, 150 * fib, m * 0.8);
        gg = mix(gg, 92 * fib, m * 0.8);
        bb = mix(bb, 84 * fib, m * 0.8);
        // grime settles into worn leather
        const dirt = w * 0.35 * sstep(0.45, 0.75, b);
        r = mix(r, 70, dirt); gg = mix(gg, 48, dirt); bb = mix(bb, 36, dirt);
        cd[o] = r; cd[o + 1] = gg; cd[o + 2] = bb; cd[o + 3] = 255;

        const height = 128 + (g - 0.5) * (22 + 70 * m + 20 * w) - m * 14;
        bd[o] = bd[o + 1] = bd[o + 2] = height; bd[o + 3] = 255;

        const lacquer = (1 - 0.55 * w) * (1 - m);
        const rough = mix(mix(0.3, 0.62, w), 0.96, m);
        sd[o] = lacquer * 255; sd[o + 1] = rough * 255; sd[o + 2] = 0; sd[o + 3] = 255;
      }
    }
    const cc = this.color.getContext('2d');
    const bc = this.bump.getContext('2d');
    const sc = this.surface.getContext('2d');
    cc.putImageData(this._img.color, 0, 0);
    bc.putImageData(this._img.bump, 0, 0);
    sc.putImageData(this._img.surface, 0, 0);

    this._quarterSeams(cc, bc);
    this._stamp(cc, bc, wearA);
    this._seam(cc, bc, sc, seam, (wearA + wearB) / 2);

    this.colorTex.needsUpdate = true;
    this.bumpTex.needsUpdate = true;
    this.surfaceTex.needsUpdate = true;
  }

  // The closed join in each leather half. The two halves are turned a quarter
  // turn to each other, as on a four-piece ball.
  _quarterSeams(cc, bc) {
    const edge = (16 / 180) * H;
    const draw = (ctx, style, width) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const x of [0.5, W / 2, W - 0.5]) { ctx.moveTo(x, 0); ctx.lineTo(x, H / 2 - edge); }
      for (const x of [W / 4, (3 * W) / 4]) { ctx.moveTo(x, H / 2 + edge); ctx.lineTo(x, H); }
      ctx.stroke();
    };
    draw(cc, 'rgba(40, 6, 10, 0.55)', 2);
    draw(bc, 'rgba(70, 70, 70, 0.9)', 2.5);
  }

  // Gold-leaf maker's stamp on the off-side half. It wears off with the lacquer.
  _stamp(cc, bc, wear) {
    const alpha = Math.max(0, 1 - 1.5 * wear);
    if (alpha <= 0.02) return;
    const lat = 43;
    const y = H / 2 - (lat / 180) * H;
    const stretch = 1 / Math.cos((lat * Math.PI) / 180);
    for (const [ctx, style] of [[cc, `rgba(214, 176, 92, ${0.9 * alpha})`], [bc, `rgba(96, 96, 96, ${alpha})`]]) {
      ctx.save();
      ctx.translate(W / 4, y);
      ctx.scale(stretch, 1);
      ctx.fillStyle = style;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 30px Georgia, "Times New Roman", serif';
      ctx.fillText('SWING LAB', 0, -12);
      ctx.font = 'italic 15px Georgia, "Times New Roman", serif';
      ctx.fillText('Hand stitched  156 g', 0, 14);
      ctx.restore();
    }
  }

  // Primary seam: a centre join with three rows of stitches either side.
  _seam(cc, bc, sc, seam, wear) {
    const mid = H / 2;
    const pxPerDeg = H / 180;
    const rows = [3.6, 8.6, 13.4];
    const count = 84;
    const pitch = W / count;

    // the leather under the stitching is pulled tight and slightly darker
    const band = 15.5 * pxPerDeg;
    const grd = cc.createLinearGradient(0, mid - band, 0, mid + band);
    grd.addColorStop(0, 'rgba(40, 4, 8, 0)');
    grd.addColorStop(0.25, 'rgba(40, 4, 8, 0.28)');
    grd.addColorStop(0.75, 'rgba(40, 4, 8, 0.28)');
    grd.addColorStop(1, 'rgba(40, 4, 8, 0)');
    cc.fillStyle = grd;
    cc.fillRect(0, mid - band, W, band * 2);

    // raised ridge on the bump map, flattened as the seam wears
    const lift = Math.round(40 + 70 * seam);
    const bg = bc.createLinearGradient(0, mid - band, 0, mid + band);
    bg.addColorStop(0, 'rgba(255,255,255,0)');
    bg.addColorStop(0.3, `rgba(255,255,255,${(lift / 255) * 0.6})`);
    bg.addColorStop(0.5, `rgba(255,255,255,${(lift / 255) * 0.35})`);
    bg.addColorStop(0.7, `rgba(255,255,255,${(lift / 255) * 0.6})`);
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    bc.fillStyle = bg;
    bc.fillRect(0, mid - band, W, band * 2);

    // centre join
    cc.strokeStyle = 'rgba(30, 3, 6, 0.8)';
    cc.lineWidth = 1.6;
    cc.beginPath(); cc.moveTo(0, mid); cc.lineTo(W, mid); cc.stroke();
    bc.strokeStyle = 'rgba(40, 40, 40, 0.9)';
    bc.lineWidth = 2;
    bc.beginPath(); bc.moveTo(0, mid); bc.lineTo(W, mid); bc.stroke();

    // thread: off-white waxed linen, greying and picking up dye as it wears
    const tr = Math.round(mix(236, 168, wear)), tg = Math.round(mix(226, 138, wear)), tb = Math.round(mix(204, 116, wear));
    const thread = `rgb(${tr}, ${tg}, ${tb})`;
    const threadShadow = 'rgba(28, 4, 6, 0.55)';
    const halfLen = pitch * 0.36;
    const stitch = (ctx, style, width, dy) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      rows.forEach((deg, ri) => {
        for (const side of [-1, 1]) {
          const y = mid + side * deg * pxPerDeg + dy;
          const slant = side * (ri % 2 ? -1 : 1) * 2.2;
          const offset = (ri % 2) * pitch * 0.5;
          for (let k = -1; k <= count; k++) {
            const x = k * pitch + offset + pitch / 2;
            ctx.moveTo(x - halfLen, y - slant);
            ctx.lineTo(x + halfLen, y + slant);
          }
        }
      });
      ctx.stroke();
    };
    stitch(cc, threadShadow, 3.6, 1.2);
    stitch(cc, thread, 2.6, 0);
    stitch(bc, `rgba(255, 255, 255, ${0.35 + 0.6 * seam})`, 3.2, 0);
    stitch(sc, 'rgb(40, 235, 0)', 3.2, 0); // thread is matt, no lacquer
  }

  dispose() {
    this.colorTex.dispose();
    this.bumpTex.dispose();
    this.surfaceTex.dispose();
  }
}

/** Sphere with the primary seam standing proud of the leather. Local +Y is the seam normal. */
export function ballGeometry(radius, seam) {
  const geo = new THREE.SphereGeometry(radius, 128, 128);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const rise = 0.006 + 0.02 * seam; // fraction of the radius
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const lat = (Math.asin(Math.max(-1, Math.min(1, v.y / radius))) * 180) / Math.PI;
    const ridge = Math.exp(-((lat / 11.5) ** 4));
    v.multiplyScalar(1 + rise * ridge);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}
