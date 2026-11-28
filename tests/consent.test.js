// Who gets asked before analytics runs, and what happens on page load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiresOptIn, decide, CONSENT_REGIONS } from '../src/consent.js';

test('European time zones must opt in', () => {
  for (const tz of ['Europe/London', 'Europe/Berlin', 'Europe/Zurich', 'Europe/Dublin', 'Atlantic/Reykjavik', 'Atlantic/Canary', 'Asia/Nicosia', 'Indian/Reunion']) {
    assert.equal(requiresOptIn(tz), true, tz);
  }
});

test('time zones elsewhere are counted by default', () => {
  for (const tz of ['Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Karachi', 'Africa/Johannesburg', 'Pacific/Auckland', 'Asia/Dubai']) {
    assert.equal(requiresOptIn(tz), false, tz);
  }
});

test('an unknown time zone is asked, to be safe', () => {
  assert.equal(requiresOptIn(null), true);
  assert.equal(requiresOptIn(undefined), true);
  assert.equal(requiresOptIn(''), true);
});

test('the region list covers the EU, the rest of the EEA, the UK and Switzerland', () => {
  assert.equal(CONSENT_REGIONS.length, 32);
  assert.equal(new Set(CONSENT_REGIONS).size, 32);
  for (const c of ['DE', 'FR', 'IE', 'NO', 'IS', 'LI', 'GB', 'CH']) assert.ok(CONSENT_REGIONS.includes(c), c);
  assert.ok(!CONSENT_REGIONS.includes('UK'), 'the ISO code is GB');
});

test('first visit from Europe: ask, and load nothing until answered', () => {
  assert.deepEqual(decide({ stored: null, optIn: true, gpc: false }), { load: false, ask: true, notice: false });
});

test('first visit from elsewhere: count, and say so', () => {
  assert.deepEqual(decide({ stored: null, optIn: false, gpc: false }), { load: true, ask: false, notice: true });
});

test('a saved yes or no is honoured everywhere without asking again', () => {
  for (const optIn of [true, false]) {
    for (const gpc of [true, false]) {
      assert.deepEqual(decide({ stored: 'granted', optIn, gpc }), { load: true, ask: false, notice: false });
      assert.deepEqual(decide({ stored: 'denied', optIn, gpc }), { load: false, ask: false, notice: false });
    }
  }
});

test('Global Privacy Control is a standing no', () => {
  assert.deepEqual(decide({ stored: null, optIn: false, gpc: true }), { load: false, ask: false, notice: false });
  assert.deepEqual(decide({ stored: null, optIn: true, gpc: true }), { load: false, ask: false, notice: false });
  assert.deepEqual(decide({ stored: 'notified', optIn: false, gpc: true }), { load: false, ask: false, notice: false });
});

test('a visitor already told about counting is not told again', () => {
  assert.deepEqual(decide({ stored: 'notified', optIn: false, gpc: false }), { load: true, ask: false, notice: false });
});

test('"told about it" never counts as consent in Europe', () => {
  assert.deepEqual(decide({ stored: 'notified', optIn: true, gpc: false }), { load: false, ask: true, notice: false });
});
