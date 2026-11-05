import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveConfig, validate } from '../src/declarative.mjs';
import { parseStory, plan } from '../src/plan.mjs';
import { actionOf } from '../src/steps.mjs';
import { newRunDir, runId } from '../src/util.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-'));

test('run folders are never reused', () => {
  const base = tmp();
  const dirs = new Set(Array.from({ length: 50 }, () => newRunDir(base)));
  assert.equal(dirs.size, 50);
  assert.match(path.basename([...dirs][0]), /^\d{8}-\d{6}-[a-z0-9]{1,4}$/);
  // An explicit --out that already has files gets a fresh subfolder instead of being written into.
  const used = tmp();
  fs.writeFileSync(path.join(used, 'tour.mp4'), 'old');
  const d = newRunDir(used, { explicit: true });
  assert.notEqual(d, path.resolve(used));
  assert.equal(fs.readFileSync(path.join(used, 'tour.mp4'), 'utf8'), 'old');
  assert.match(runId(), /^\d{8}-\d{6}-/);
});

test('parseStory finds the id, title and acceptance criteria', () => {
  const s = parseStory(fs.readFileSync(new URL('../examples/stories/RMS-6142.md', import.meta.url), 'utf8'));
  assert.equal(s.id, 'RMS-6142');
  assert.equal(s.title, 'Publish MD IBR fields in Dynamic and Standard Reporting');
  assert.equal(s.acceptanceCriteria.length, 3);
  assert.match(s.acceptanceCriteria[1], /Enterprise Print Designer/);
});

test('parseStory keeps a pasted Jira criterion of several sentences together', () => {
  const s = parseStory('RMS-6445 Complete button\n\nAcceptance Criteria\n\nComplete stays clickable. It is not disabled.\n\nThe banner says "Errors below must be resolved before completing".\n');
  assert.equal(s.id, 'RMS-6445');
  assert.equal(s.title, 'Complete button');
  assert.deepEqual(s.acceptanceCriteria, ['Complete stays clickable. It is not disabled.', 'The banner says "Errors below must be resolved before completing".']);
  assert.equal(parseStory('X-1 t\nAcceptance criteria: First works. Second works.').acceptanceCriteria.length, 2);
});

test('environments, BASE_URL and --base-url resolve in that order', () => {
  const raw = { name: 'x', baseUrl: 'http://a', timeouts: { action: 1 }, environments: { qa: { baseUrl: 'http://qa', timeouts: { verify: 9 } } }, scenes: [] };
  assert.equal(resolveConfig(raw).baseUrl, 'http://a');
  const qa = resolveConfig(raw, { env: 'qa' });
  assert.equal(qa.baseUrl, 'http://qa');
  assert.deepEqual(qa.timeouts, { action: 1, verify: 9 });
  process.env.BASE_URL = 'http://env';
  try {
    assert.equal(resolveConfig(raw, { env: 'qa' }).baseUrl, 'http://env');
    assert.equal(resolveConfig(raw, { env: 'qa', baseUrl: 'http://flag' }).baseUrl, 'http://flag');
  } finally { delete process.env.BASE_URL; }
  assert.throws(() => resolveConfig(raw, { env: 'prod' }), /No environment "prod"/);
});

test('validate reports every problem in a tour.json', () => {
  assert.throws(() => validate({ scenes: [{ narration: 'x' }] }, 't.json'), e => /baseUrl/.test(e.message) && /title/.test(e.message));
});

test('heuristic plan uses only discovered names and writes tour.json + script.md', async () => {
  const out = tmp();
  const discovery = { origin: 'http://app', pages: [{ path: '/', title: 'Demo', url: 'http://app/', headings: [{ level: 'H1', name: 'Dashboard' }],
    links: [{ name: 'Reports', href: 'http://app/reports', nav: true }], buttons: [{ name: 'New report' }, { name: 'Delete all' }],
    fields: [{ label: '', placeholder: 'Search', type: 'search' }], tabs: [], excerpt: 'Welcome' }] };
  const tour = await plan({ discovery, outDir: out, name: 'demo' });
  assert.ok(fs.existsSync(path.join(out, 'tour.json')) && fs.existsSync(path.join(out, 'script.md')));
  const steps = tour.scenes.flatMap(s => s.steps);
  steps.forEach(s => actionOf(s));
  const json = JSON.stringify(steps);
  assert.match(json, /"Search"/);
  assert.match(json, /New report/);
  assert.doesNotMatch(json, /Delete all/); // destructive-looking buttons are left out
});

test('a story without AI becomes a per-criterion draft', async () => {
  const out = tmp();
  const story = parseStory('ABC-1 "Do a thing"\nAcceptance criteria:\n- First thing works.\n- Second thing works.');
  const tour = await plan({ discovery: null, outDir: out, name: 'abc', story });
  assert.equal(tour.draft, true);
  assert.equal(tour.scenes.length, 3);
  assert.deepEqual(tour.scenes[2].criteria, [2]);
});
