import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprints, plan, preview } from '../src/reuse.mjs';

const speech = (s, d) => ({ voice: s.voice ?? d.voice ?? null, rate: s.rate ?? 0, tail: s.hold ?? 0.75 });
const tour = (scenes, extra = {}) => ({ raw: { baseUrl: 'http://x/', scenes, ...extra }, pronounce: {}, env: 'local' });
const browser = (n, narration = `scene ${n}`) => ({ title: `B${n}`, narration, url: `#/${n}`, steps: [{ click: `Go ${n}` }, { verify: `Done ${n}` }] });
const slide = t => ({ title: t, narration: t, slide: { heading: t } });

/** An earlier run folder with a clip for each of its browser scenes. */
function runWith(fp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-reuse-'));
  fs.mkdirSync(path.join(dir, 'clips'));
  for (const s of fp.scenes.filter(x => x.browser)) fs.writeFileSync(path.join(dir, 'clips', `${s.id}.mp4`), '');
  return dir;
}

test('reuse: unchanged browser scenes are reused even when slides are added or edited', () => {
  const old = fingerprints(tour([slide('A'), browser(1), browser(2)]), speech);
  const fresh = fingerprints(tour([slide('A, edited'), slide('New'), browser(1), browser(2)]), speech);
  const p = plan(fresh, old, runWith(old));
  assert.equal(p.all, true);
  assert.deepEqual(p.scenes.map(s => [s.id, s.from]), [['scene-03', 'scene-02'], ['scene-04', 'scene-03']]);
});

test('reuse: from the first changed browser scene on, everything is recorded', () => {
  const old = fingerprints(tour([browser(1), browser(2), browser(3)]), speech);
  const fresh = fingerprints(tour([browser(1), browser(2, 'new words'), browser(3)]), speech);
  const p = plan(fresh, old, runWith(old));
  assert.equal(p.all, false);
  assert.deepEqual(p.scenes.map(s => s.id), ['scene-01']);
  assert.equal(p.fromStep, 3); // scene 1's two steps run fast, unfilmed
  assert.match(p.changed, /scene-02/);
});

test('reuse: a changed step, voice or app setting counts as a change', () => {
  const base = [browser(1)];
  const old = fingerprints(tour(base), speech);
  const dir = runWith(old);
  const step = structuredClone(base); step[0].steps[0] = { click: 'Other' };
  assert.equal(plan(fingerprints(tour(step), speech), old, dir).scenes.length, 0);
  const voice = structuredClone(base); voice[0].voice = 'David';
  assert.equal(plan(fingerprints(tour(voice), speech), old, dir).scenes.length, 0);
  const p = plan(fingerprints(tour(base, { fixtureSteps: [{ goto: '/' }] }), speech), old, dir);
  assert.equal(p.scenes.length, 0);
  assert.match(p.changed, /app settings/);
  // Presentation only (the story, slide look): still reusable.
  assert.equal(plan(fingerprints(tour(base, { story: { id: 'X-1' }, slides: { theme: 'light' } }), speech), old, dir).all, true);
});

test('reuse: a scene chosen to record again is recorded, and every scene after it', () => {
  const old = fingerprints(tour([browser(1), browser(2), browser(3)]), speech);
  const fresh = fingerprints(tour([browser(1), browser(2), browser(3)]), speech);
  const dir = runWith(old);
  const p = plan(fresh, old, dir, { force: ['2'] });
  assert.deepEqual(p.scenes.map(s => s.id), ['scene-01']);
  assert.match(p.changed, /scene-02 was chosen/);
  const v = preview(fresh, old, dir, { force: [2] });
  assert.deepEqual(v.scenes.map(s => [s.number, s.state, s.changed, s.forced]), [[1, 'reuse', false, false], [2, 'record', false, true], [3, 'after', false, false]]);
});

test('reuse: a scene whose clip is missing is recorded', () => {
  const old = fingerprints(tour([browser(1)]), speech);
  const dir = runWith(old);
  fs.rmSync(path.join(dir, 'clips', 'scene-01.mp4'));
  assert.equal(plan(fingerprints(tour([browser(1)]), speech), old, dir).scenes.length, 0);
});
