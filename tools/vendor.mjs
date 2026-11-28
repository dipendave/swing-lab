// Copy the Three.js files the page loads into vendor/three.
//
//   npm run vendor            from node_modules/three
//   node tools/vendor.mjs <path to an unpacked three package>
//
// The add-ons are followed through their own imports, so naming the ones the
// site uses is enough.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = process.argv[2] || join(root, 'node_modules', 'three');
const to = join(root, 'vendor', 'three');
const ADDONS = [
  'controls/OrbitControls.js',
  'lines/Line2.js', 'lines/LineMaterial.js', 'lines/LineGeometry.js',
  'csm/CSM.js',
  'postprocessing/EffectComposer.js', 'postprocessing/RenderPass.js', 'postprocessing/ShaderPass.js',
  'postprocessing/GTAOPass.js', 'postprocessing/UnrealBloomPass.js', 'postprocessing/OutputPass.js',
];

const seen = new Set();
const todo = [...ADDONS];
while (todo.length) {
  const file = todo.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(join(from, 'examples', 'jsm', file), 'utf8');
  for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) todo.push(normalize(join(dirname(file), m[1])));
}

rmSync(join(to, 'addons'), { recursive: true, force: true });
for (const file of [...seen].sort()) {
  mkdirSync(dirname(join(to, 'addons', file)), { recursive: true });
  copyFileSync(join(from, 'examples', 'jsm', file), join(to, 'addons', file));
}
copyFileSync(join(from, 'build', 'three.module.min.js'), join(to, 'three.module.min.js'));
copyFileSync(join(from, 'LICENSE'), join(to, 'LICENSE'));
console.log(`three ${JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version}: ${seen.size} add-on files`);
