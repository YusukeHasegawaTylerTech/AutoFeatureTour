import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseScript, spokenText } from '../src/script.mjs';
import { parseArgs } from '../src/util.mjs';

test('parseScript splits scenes, skips notes and capture cues', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aft-')), 'script.md');
  fs.writeFileSync(file, '# Title\n\nPresenter notes.\n\n## 1. Intro\n*App: home page*\n\nHello there.\nSecond line.\n\n## 2. Next\nMore.\n');
  const scenes = parseScript(file);
  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes.map(s => s.id), ['scene-01', 'scene-02']);
  assert.equal(scenes[0].title, 'Intro');
  assert.equal(scenes[0].narration, 'Hello there. Second line.');
  assert.deepEqual(scenes[0].cues, ['App: home page']);
});

test('parseScript rejects a script without scenes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aft-')), 'empty.md');
  fs.writeFileSync(file, '# Nothing here\n');
  assert.throws(() => parseScript(file), /No "## N. Title" scenes/);
});

test('spokenText strips markdown and applies pronunciations longest-first as listed', () => {
  assert.equal(spokenText('*Agentic FOIA* handles `FOIA` requests', { 'Agentic FOIA': 'Agentic Foya', FOIA: 'Foya' }),
    'Agentic Foya handles Foya requests');
});

test('parseArgs handles flags, values and = forms', () => {
  assert.deepEqual(parseArgs(['tour.mjs', '--record', '--engine', 'Placeholder', '--api-port=5191', '--skip-build']),
    { _: ['tour.mjs'], record: true, engine: 'Placeholder', apiPort: '5191', skipBuild: true });
});
