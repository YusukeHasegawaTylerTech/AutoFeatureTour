// The step vocabulary, against the fixture app's /vocab page: every step type works, and each kind of failure gets
// the right class. `validate` (a dry run that collects every step's result) keeps it to one browser per tour.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

function aft(args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args, '--json'], { windowsHide: true, cwd: root, env: { ...process.env, AFT_OUT_DIR: path.join(os.tmpdir(), 'aft-test-out') } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => { let doc = null; try { doc = JSON.parse(out); } catch { /* checked by callers */ } resolve({ code, doc, err }); });
  });
}

/** Validates a stand-alone tour of /vocab; returns the per-step report. */
async function vocab(steps, { url = '/vocab', ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-vocab-'));
  const file = path.join(dir, 'vocab.tour.json');
  fs.copyFileSync(path.join(root, 'test', 'fixture', 'attachment.txt'), path.join(dir, 'attachment.txt'));
  fs.writeFileSync(file, JSON.stringify({ name: 'vocab', baseUrl: app.url, timeouts: { action: 3000, verify: 2000, waitFor: 2000 }, retries: 0, ...extra,
    scenes: [{ title: 'Vocabulary', narration: 'Every step.', url, steps }] }));
  const r = await aft(['validate', file]);
  const vj = r.doc?.runDir && path.join(r.doc.runDir, 'validation.json');
  const report = vj && fs.existsSync(vj) ? JSON.parse(fs.readFileSync(vj, 'utf8')).report : [];
  return { ...r, report: report.filter(s => s.scene === 'scene-01') };
}

describe('step vocabulary', { concurrency: 3, timeout: 600000 }, () => {
  test('every step type works', async () => {
    const steps = [
      { click: { role: 'button', name: 'Open', within: { role: 'region', name: 'Panel B' } } },
      { verify: '#which', text: 'opened Panel B' },
      { verify: { role: 'row', hasText: 'Beta' }, count: 1 },
      { verify: { role: 'tab', name: '/^Review \\(\\d+\\)$/' } }, { verify: { role: 'row', hasText: '/^Bet/' }, count: 1 },
      { verify: { text: 'Case Report:' }, text: '/Case Report:\\s*Complete/', near: true },
      { verify: { role: 'row', has: { role: 'button', name: 'Edit' } }, count: 2 },
      { verify: { role: 'row', hasNotText: 'Alpha', has: { role: 'button' } }, count: 1 },
      { check: 'I agree' }, { verify: 'I agree', state: 'checked' }, { uncheck: 'I agree' }, { verify: 'I agree', state: 'unchecked' },
      { select: 'Color', option: 'Green' }, { verify: 'Color', value: 'Green' },
      { clear: 'Notes' }, { verify: 'Notes', value: '' },
      { type: 'Keys', text: 'abc', delay: 10 }, { verify: '#keycount', exactText: '3' },
      { press: 'End', on: 'Keys' },
      { focus: 'Notes' }, { verify: 'Notes', state: 'focused' },
      { dialog: 'dismiss' }, { click: 'Delete' }, { verify: '#asked', exactText: 'cancelled' },
      { dialog: 'accept', text: 'Ann', expect: 'name' }, { click: 'Ask name' }, { verify: '#answer', exactText: 'Ann' },
      { upload: 'Attachment', files: 'attachment.txt' }, { verify: '#filename', text: 'attachment.txt' },
      { drag: '#src', to: '#dst' }, { verify: '#dropped', text: 'dropped Card' },
      { click: 'Toggle' }, { verify: { text: 'Details panel' }, state: 'hidden' }, { click: 'Toggle' }, { verify: { text: 'Details panel' }, state: 'visible' },
      { click: 'Load', waitForResponse: '/api/echo', status: 200 }, { verify: '#net', text: 'echo 200' },
      { verify: 'Locked', state: 'disabled' },
      { click: { role: 'button', name: 'Inside', frame: 'iframe' } }, { verify: { text: 'Clicked inside', frame: 'iframe' } },
      { dblclick: { text: 'Alpha' } }, { rightClick: { text: 'Alpha' } }, { hover: 'Load' },
      { download: 'Download report', expect: 'report-2026' },
      { verify: { url: '/vocab' } }, { verify: { title: '/^Voc/' } },
      { mock: '/api/echo', status: 201, json: { mocked: true } }, { click: 'Load' }, { verify: '#net', text: 'echo 201' },
      { click: 'Open in new tab', opensPopup: true }, { verify: { title: 'OK' } }, { switchTo: 'main' }, { verify: { title: 'Vocab' } },
      { scroll: '#dst' }, { waitFor: '#panel', state: 'attached' },
    ];
    const r = await vocab(steps, { allowMocks: true });
    assert.equal(r.code, 0, `${r.err}\n${JSON.stringify(r.report.filter(s => !s.ok), null, 1)}`);
    assert.equal(r.report.length, steps.length);
    assert.ok(r.report.every(s => s.ok));
    assert.ok(r.report.find(s => s.action === 'mock').warnings.some(w => /mocked/.test(w)));
  });

  test('each failure gets its class', async () => {
    const steps = [
      { verify: { role: 'row' }, count: 5 },                                          // 1 criterion: count
      { click: 'Break', waitForResponse: '/api/fail', status: 200 },                  // 2 app: wrong status
      { dialog: 'accept', expect: 'Remove' }, { click: 'Delete' },                     // 4 criterion: dialog text
      { download: 'Download report', expect: 'invoice' },                             // 5 criterion: file name
      { verify: 'I agree', state: 'checked' },                                        // 6 criterion: state
      { waitFor: '#panel', state: 'detached', timeout: 800 },                         // 7 script: never detached
      { verify: { url: '/elsewhere' } },                                              // 8 criterion: url
      { click: { role: 'button', name: 'Nope', within: { role: 'region', name: 'Panel B' } }, timeout: 800 }, // 9 script
      { verify: '#which', exactText: 'something' },                                   // 10 criterion: text
    ];
    const r = await vocab(steps);
    assert.equal(r.code, 2, r.err); // validate: blocking failures
    const by = n => r.report.find(s => s.step === n);
    assert.deepEqual([1, 2, 4, 5, 6, 7, 8, 9, 10].map(n => [n, by(n)?.failure]),
      [[1, 'criterion'], [2, 'app'], [4, 'criterion'], [5, 'criterion'], [6, 'criterion'], [7, 'script'], [8, 'criterion'], [9, 'script'], [10, 'criterion']]);
    assert.match(by(1).error, /\d+ visible, expected 5/);
    assert.match(by(2).error, /GET \S*\/api\/fail 500 \(expected 200\)/);
    assert.match(by(4).error, /said "Delete it\?", expected "Remove"/);
    assert.match(by(5).error, /downloaded "report-2026.txt"/);
  });

  test('mock steps need "allowMocks"; schema errors are config errors with exact paths', async () => {
    const m = await vocab([{ mock: '/api/echo', status: 500 }]);
    assert.equal(m.code, 1);
    assert.match(m.doc.error.message, /allowMocks/);
    const s = await vocab([{ click: { nmae: 'x' } }, { fill: 'Notes', txet: 'x' }, { verify: 'X', state: 'shiny' }]);
    assert.equal(s.code, 1);
    assert.equal(s.doc.class, 'error');
    const err = s.err;
    assert.match(err, /scenes\[0\]\.steps\[0\]\.click: unknown key "nmae"/);
    assert.match(err, /scenes\[0\]\.steps\[1\]: unknown key "txet"/);
    assert.match(err, /scenes\[0\]\.steps\[2\]\.state: expected one of/);
  });
});

// After the block above, not alongside it: more browsers at once would squeeze its tight waitFor timeouts.
describe('captured values, pinned bars, text case', { concurrency: 2, timeout: 600000 }, () => {
  test('capture and {vars.x}; clicks under a fixed footer; text checks against CSS capitals', async () => {
    const r = await vocab([
      { capture: '#code', as: 'code' },
      { capture: { css: '#link' }, attribute: 'href', pattern: '/item/(\\d+)/', as: 'item' },
      { fill: 'Code to enter', text: '{vars.code}' },
      { verify: 'Code to enter', value: '{vars.code}' },
      { verify: '#code', exactText: '{vars.code}' },
      { goto: '/pinned?item={vars.item}' },
      { capture: { url: true }, pattern: 'item=(\\d+)', as: 'again' },
      { verify: { url: 'item={vars.again}' } },
      { click: 'Low button' },                           // covered by the fixed toolbar until scrolled to the middle
      { verify: '#clicked', text: 'low clicked' },
      { verify: '#status', text: 'Paused' },              // shown as PAUSED
      { verify: '#status', exactText: 'Paused' },
    ], { url: '/pinned' });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.report.every(s => s.ok), JSON.stringify(r.report.filter(s => !s.ok)));
  });

  test('capture failures and case-only text mismatches say what to fix', async () => {
    const r = await vocab([
      { fill: 'Code to enter', text: '{vars.never}' },                     // 1 not captured
      { capture: '#code', pattern: '^X(\\d+)$', as: 'bad' },              // 2 no match
      { verify: '#status', text: 'PAUSED d' },                            // 3 unrelated: no case hint
      { verify: '#status', exactText: 'pAUSED' },                         // 4 case only
    ], { url: '/pinned' });
    const by = n => r.report.find(s => s.step === n);
    assert.equal(by(1).failure, 'script');
    assert.match(by(1).error, /no captured value "never"/);
    assert.equal(by(2).failure, 'script');
    assert.match(by(2).error, /doesn't match/);
    assert.equal(by(3).failure, 'criterion');
    assert.doesNotMatch(by(3).error, /case is ignored/);
    assert.match(by(4).error, /matches if case is ignored/);
  });

});
