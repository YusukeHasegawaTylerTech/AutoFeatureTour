// Known issues (workarounds), and the smaller run behaviours that came with them: tab state, goto to the current URL,
// error response bodies, data from setup hooks, mock gating, video trimming, Git Bash argument detection. Runs the real
// CLI against the fixture app's /known and /tabs pages; merge and trim rules are checked in-process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { trimPlan } from '../src/render.mjs';
import { mergeWorkarounds, workaroundProblems } from '../src/workarounds.mjs';
import { startFixture } from './fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.mjs');
let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

function runCli(args, { env = {} } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [cli, ...args], { windowsHide: true, cwd: root, env: { ...process.env, AFT_OUT_DIR: path.join(os.tmpdir(), 'aft-test-out'), ...env } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code, out }));
  });
}

const POPUP = { name: 'TCM popup', when: { role: 'dialog', hasText: 'TCM' }, do: [{ click: { role: 'button', name: 'Ok' } }] };
const STORAGE = { name: 'File Storage popup', when: { role: 'dialog', hasText: 'File Storage' }, do: [{ click: { role: 'button', name: 'Ok' } }] };
const PANEL = { name: 'TCM panel', when: { css: '.error-panel', hasText: 'TCM' }, do: 'tolerate' };
const ERRORS = { selector: '.error-panel, [role=dialog]', text: 'error|unavailable' };

/** Runs a one-scene stand-alone tour; returns exit code, report.json, the log and the run folder. */
async function tour(steps, { url = '/known', args = [], env, ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-wa-'));
  const file = path.join(dir, 'tour.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'known', baseUrl: app.url, timeouts: { action: 3000, verify: 3000, navigation: 5000, optional: 1000 }, retries: 0,
    scenes: [{ title: 'Known', narration: 'Testing known issues.', url, steps }], ...extra }));
  const out = path.join(dir, 'run');
  const r = await runCli(['run', file, '--speech', 'silent', '--out', out, ...args], { env });
  const rf = path.join(out, 'report.json');
  return { code: r.code, log: r.out, out, report: fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : null };
}

describe('workarounds', { concurrency: 3, timeout: 900000 }, () => {
  test('popup at a random moment: dismissed, the step passes, a warning names it', async () => {
    const r = await tour([{ wait: 0.6 }, { click: 'Save' }, { verify: { text: 'Saved' } }], { url: '/known?popup=1', workarounds: [POPUP], errors: ERRORS });
    assert.equal(r.code, 0, r.log);
    // The page loads twice (the session check, then the scene's url), so the popup can come twice: each is dismissed.
    assert.ok(r.report.workarounds.length >= 1);
    assert.ok(r.report.workarounds.every(w => w.name === 'TCM popup' && w.action === 'dismissed'), JSON.stringify(r.report.workarounds));
    assert.ok(r.report.warnings.some(w => /known issue "TCM popup"/.test(w)), JSON.stringify(r.report.warnings));
    assert.equal(r.report.workaroundRules[0].source, 'platform');
    assert.match(fs.readFileSync(path.join(r.out, 'report.md'), 'utf8'), /Known issues \(workarounds\)/);
  });

  test('two stacked known dialogs: newest first, each "Ok" scoped to its own dialog', async () => {
    const r = await tour([{ wait: 0.6 }, { click: 'Save' }, { verify: { text: 'Saved' } }], { url: '/known?popup=1&stack=1', workarounds: [POPUP, STORAGE], errors: ERRORS });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.report.workarounds.map(w => w.name).slice(0, 2), ['File Storage popup', 'TCM popup']);
  });

  test('inline error panel matching "errors": tolerated, the run passes with a warning', async () => {
    const r = await tour([{ click: 'Save' }, { verify: { text: 'Saved' } }], { url: '/known?panel=1', workarounds: [PANEL], errors: ERRORS });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.report.workarounds[0].action, 'tolerated');
    const without = await tour([{ click: 'Save' }], { url: '/known?panel=1', errors: ERRORS });
    assert.equal(without.code, 5, 'without the workaround the panel is an APP error');
  });

  test('a matched 5xx is tolerated even with appErrors.network = fail; its body is kept', async () => {
    const rule = { name: 'TCM lookup', when: { request: '/api/tcm', status: '5xx' } };
    const r = await tour([{ click: 'Save' }, { verify: { text: 'tcm 503' } }], { url: '/known?tcm=1', workarounds: [rule], appErrors: { network: 'fail' } });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.report.workarounds[0].name, 'TCM lookup');
    const bare = await tour([{ click: 'Save' }, { wait: 0.5 }], { url: '/known?tcm=1', appErrors: { network: 'fail' } });
    assert.equal(bare.code, 5, bare.log);
    assert.match(bare.report.firstCause.body ?? '', /down for maintenance/, 'the error response body is kept');
  });

  test('"as": "fail": APP, exit 5, the first cause is the known issue', async () => {
    const r = await tour([{ wait: 0.6 }, { click: 'Save' }], { url: '/known?popup=1', workarounds: [{ ...POPUP, as: 'fail' }], errors: ERRORS });
    assert.equal(r.code, 5, r.log);
    assert.equal(r.report.firstCause.kind, 'workaround');
    assert.equal(r.report.firstCause.name, 'TCM popup');
  });

  test('"times" used up: the next one is a normal error again', async () => {
    const r = await tour([{ click: 'Save' }], { url: '/known?panel=1&two=1', workarounds: [{ name: 'any panel', when: { css: '.error-panel' }, times: 1 }], errors: ERRORS });
    assert.equal(r.code, 5, r.log);
    assert.equal(r.report.workarounds.length, 1, 'one tolerated, the other is an error');
  });

  test('issue absent: no warnings, no firings', async () => {
    const r = await tour([{ click: 'Save' }, { verify: { text: 'Saved' } }], { workarounds: [POPUP, PANEL], errors: ERRORS });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.report.workarounds.length, 0);
    assert.equal(r.report.warnings.length, 0, JSON.stringify(r.report.warnings));
  });

  test('environment rules merge over the platform\'s by name; "off" disables; partial needs a platform rule', () => {
    const merged = mergeWorkarounds([POPUP, PANEL], [{ name: 'TCM popup', as: 'fail' }, { name: 'TCM panel', off: true }, { name: 'qa only', when: { console: 'x' } }], 'qa');
    assert.deepEqual(merged.map(r => [r.name, r.as ?? 'warn', r.source]), [['TCM popup', 'fail', 'env:qa'], ['qa only', 'warn', 'env:qa']]);
    assert.ok(merged[0].do, 'partial entry keeps the platform rule\'s "do"');
    assert.equal(workaroundProblems(mergeWorkarounds([], [{ name: 'orphan', as: 'fail' }], 'qa')).length, 1);
  });
});

describe('other run behaviours', { concurrency: 3, timeout: 900000 }, () => {
  test('tabs: state selected / unselected, and checked falls back to aria-selected', async () => {
    const r = await tour([{ verify: { role: 'tab', name: 'Review' }, state: 'selected' }, { click: { role: 'tab', name: 'IBR' } },
      { verify: { role: 'tab', name: 'IBR' }, state: 'checked' }, { verify: { role: 'tab', name: 'Review' }, state: 'unselected' }], { url: '/tabs' });
    assert.equal(r.code, 0, r.log);
  });

  test('goto the URL already open reloads the page', async () => {
    // A hash route: without a reload, the selected tab (UI state) would survive the goto.
    const sel = name => ({ verify: { role: 'tab', name }, state: 'selected' });
    const r = await tour([{ click: { role: 'tab', name: 'IBR' } }, sel('IBR'), { goto: '/tabs#a' }, sel('Review'),
      { click: { role: 'tab', name: 'IBR' } }, { goto: '/tabs#b', reload: true }, sel('Review')], { url: '/tabs#a' });
    assert.equal(r.code, 0, r.log);
  });

  test('a setup hook with "output" provides {data.x} at run time; a missing one is a SCRIPT failure', async () => {
    const hooks = { setup: [{ node: 'lookup.mjs', output: 'text', as: 'path' }] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-hook-'));
    fs.writeFileSync(path.join(dir, 'lookup.mjs'), 'console.log("/tabs");\n');
    const file = path.join(dir, 'tour.json');
    const t = steps => ({ name: 'hook', baseUrl: app.url, timeouts: { action: 3000, verify: 3000 }, retries: 0, hooks,
      scenes: [{ title: 'Hook', narration: 'Hook data.', url: '{data.path}', steps }] });
    fs.writeFileSync(file, JSON.stringify(t([{ verify: { role: 'tab', name: 'Review' } }])));
    const ok = await runCli(['run', file, '--speech', 'silent', '--out', path.join(dir, 'ok')]);
    assert.equal(ok.code, 0, ok.out);
    fs.writeFileSync(file, JSON.stringify(t([{ fill: 'Name', text: '{data.nope}' }])));
    const bad = await runCli(['run', file, '--speech', 'silent', '--out', path.join(dir, 'bad')]);
    assert.equal(bad.code, 2, bad.out);
    assert.match(bad.out, /no data value "nope"/);
  });

  test('mocks are refused for "style": "verification"; a mocked scene gets a "simulated data" caption', async () => {
    const mock = { mock: '/api/tcm', json: { ok: true } };
    const refused = await tour([mock], { allowMocks: true, style: 'verification' });
    assert.equal(refused.code, 1, refused.log);
    assert.match(refused.log, /verification.*can't use "mock"/);
    const r = await tour([mock, { click: 'Save' }, { verify: { text: 'tcm 200' } }], { url: '/known?tcm=1', allowMocks: true, style: 'demo' });
    assert.equal(r.code, 0, r.log);
    assert.match(fs.readFileSync(path.join(r.out, 'tour.vtt'), 'utf8'), /Simulated data/);
  });

  test('long waits are trimmed from the video and listed in timings.json; --no-trim keeps them', async () => {
    const steps = [{ waitFor: '#never', state: 'attached', timeout: 2500, optional: true }, { click: 'Save' }];
    const r = await tour(steps, { video: { trimWaitsOver: 1 } });
    assert.equal(r.code, 0, r.log);
    const timings = JSON.parse(fs.readFileSync(path.join(r.out, 'timings.json'), 'utf8'));
    assert.ok(timings.trim.trimmed[0]?.seconds > 1, JSON.stringify(timings.trim));
    const kept = await tour(steps, { video: { trimWaitsOver: 1 }, args: ['--no-trim'] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(kept.out, 'timings.json'), 'utf8')).trim.mode, 'off');
  });

  test('trimPlan: merges overlapping waits, keeps a lead-in, maps times', () => {
    const p = trimPlan({ start: 10, end: 30, waits: [{ start: 12, end: 15 }, { start: 14, end: 16 }, { start: 20, end: 21 }] }, { over: 1.5, leadIn: 0.5 });
    assert.deepEqual(p.windows, [{ start: 12.5, end: 16 }]);
    assert.equal(p.saved, 3.5);
    assert.equal(p.map(25), 21.5);
    assert.equal(trimPlan({ start: 0, end: 5, waits: [{ start: 1, end: 4 }] }, { mode: 'off' }).windows.length, 0);
  });

  test('an argument Git Bash rewrote into a Windows path is refused with the fix', async () => {
    const r = await runCli(['snapshot', '--url', 'C:/Program Files/Git/case/1'], { env: { MSYS_NO_PATHCONV: '' } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /MSYS_NO_PATHCONV=1/);
  });
});
