// The player model: the file the site loads has to agree with the skeleton the
// solver moves, and has to be internally sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { BODY, BONES, bindPose, frames, restPose } from '../src/pose.js';

const dir = new URL('../assets/figure/', import.meta.url);
const info = JSON.parse(readFileSync(new URL('figure.json', dir), 'utf8'));
const bin = readFileSync(new URL('figure.bin', dir));
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('model: its bones are the lengths the solver works with', () => {
  assert.deepEqual(info.bones, BONES);
  for (const k of ['thigh', 'shin', 'ankle', 'ballOfFoot', 'spine', 'hipHalf', 'shoulderHalf', 'upperArm', 'foreArm']) {
    assert.ok(Math.abs(info.measure[k] - BODY[k]) < 0.002, `${k}: model ${info.measure[k]}, solver ${BODY[k]}`);
  }
  assert.ok(info.measure.height > 1.78 && info.measure.height < 1.88, `stands ${info.measure.height} m`);
  // the solver's own standing pose is the same height, near enough
  assert.ok(Math.abs(restPose().headC[2] - bindPose(info.rig).headC[2]) < 0.03);
});

test('model: bound in a pose the solver could have made', () => {
  const p = bindPose(info.rig);
  const fs = frames(p);
  assert.equal(fs.length, BONES.length);
  for (const f of fs) {
    for (const v of [f.x, f.y, f.z]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
    assert.ok(Math.abs(dot(f.x, f.y)) < 1e-6 && Math.abs(dot(f.y, f.z)) < 1e-6 && Math.abs(dot(f.x, f.z)) < 1e-6);
  }
  for (const s of ['L', 'R']) {
    assert.ok(Math.abs(dist(p[s].hip, p[s].knee) - BODY.thigh) < 0.002 && Math.abs(dist(p[s].knee, p[s].ankle) - BODY.shin) < 0.002);
    assert.ok(Math.abs(dist(p[s].shoulder, p[s].elbow) - BODY.upperArm) < 0.002 && Math.abs(dist(p[s].elbow, p[s].hand) - BODY.foreArm) < 0.002);
  }
  // facing +y with the left side toward -x, feet on the ground, head on top
  assert.ok(p.L.hip[0] < 0 && p.R.hip[0] > 0 && p.gaze[1] > 0.95);
  assert.ok(Math.abs(p.L.ankle[2] - BODY.ankle) < 0.002 && p.headC[2] > 1.6);
  // the head the hats are fitted to is where the solver puts a head
  const mid = (info.rig.skullMin[1] + info.rig.skullMax[1]) / 2;
  assert.ok(Math.abs(p.headC[1] - mid) < 0.03 && p.headC[2] > info.rig.chin[2] && p.headC[2] < info.rig.crown[2]);
});

test('model: every mesh is whole, inside the file, and every vertex belongs to bones', () => {
  const names = Object.keys(info.meshes);
  assert.deepEqual(names.sort(), ['body', 'brows', 'eyes', 'hair', 'lashes', 'shoes', 'suit']);
  for (const [name, m] of Object.entries(info.meshes)) {
    const pos = new Float32Array(buf, m.position, m.vertices * 3);
    const index = m.index32 ? new Uint32Array(buf, m.index, m.triangles * 3) : new Uint16Array(buf, m.index, m.triangles * 3);
    const bone = new Uint8Array(buf, m.skinIndex, m.vertices * 4), weight = new Uint8Array(buf, m.skinWeight, m.vertices * 4);
    const normal = new Int8Array(buf, m.normal, m.vertices * 3);
    assert.ok(m.index + index.byteLength <= buf.byteLength, `${name} fits in the file`);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      assert.ok(Number.isFinite(pos[i]) && Number.isFinite(pos[i + 1]) && Number.isFinite(pos[i + 2]));
      lo = Math.min(lo, pos[i + 2]); hi = Math.max(hi, pos[i + 2]);
    }
    assert.ok(lo > -0.001 && hi < 1.9, `${name} stands between the ground and 1.9 m (${lo.toFixed(3)} to ${hi.toFixed(3)})`);
    for (const i of index) assert.ok(i < m.vertices);
    for (let v = 0; v < m.vertices; v++) {
      const sum = weight[v * 4] + weight[v * 4 + 1] + weight[v * 4 + 2] + weight[v * 4 + 3];
      assert.equal(sum, 255, `${name} vertex ${v} is fully weighted`);
      for (let k = 0; k < 4; k++) assert.ok(bone[v * 4 + k] < BONES.length);
      const n = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) / 127;
      assert.ok(n > 0.9 && n < 1.1, `${name} vertex ${v} has a unit normal`);
    }
    let covered = 0;
    for (const g of m.groups) { assert.ok(g.start + g.count <= index.length); covered += g.count; }
    if (m.groups.length) assert.equal(covered, index.length, `${name}: its groups cover every triangle`);
  }
  assert.deepEqual(info.meshes.body.groups.map((g) => g.name), ['head', 'handL', 'handR']);
  assert.deepEqual(info.meshes.suit.groups.map((g) => g.name), ['shirt', 'trousers']);
});

test('model: left and right are mirror images, and the textures are there', () => {
  const R = info.rig;
  for (const k of Object.keys(R)) {
    if (!k.endsWith('L')) continue;
    const l = R[k], r = R[`${k.slice(0, -1)}R`];
    assert.ok(Math.abs(l[0] + r[0]) < 1e-4 && Math.abs(l[1] - r[1]) < 1e-4 && Math.abs(l[2] - r[2]) < 1e-4, k);
  }
  const T = info.textures;
  for (const f of [...T.skin, T.whites, T.whitesNormal, T.shoes, T.eyes, T.brows, T.lashes, T.hair]) {
    assert.ok(statSync(new URL(f, dir)).size > 1000, f);
  }
  // small enough to arrive quickly
  let total = bin.byteLength;
  for (const f of [...T.skin, T.whites, T.whitesNormal, T.shoes, T.eyes, T.brows, T.lashes, T.hair]) total += statSync(new URL(f, dir)).size;
  assert.ok(total < 3.2e6, `the model is ${(total / 1e6).toFixed(2)} MB`);
});
