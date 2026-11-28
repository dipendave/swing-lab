// The page itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('the version shown under the title is the one in package.json', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const html = await read('index.html');
  const shown = /id="version">v([^<]+)</.exec(html);
  assert.ok(shown, 'index.html has a version label');
  assert.equal(shown[1], pkg.version);
});
