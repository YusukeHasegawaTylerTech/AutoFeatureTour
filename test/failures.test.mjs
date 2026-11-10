// Error reporting can't regress: each failure mode, triggered on demand by the fixture app, must give the right exit
// code, report.json class and a complete triage bundle. Runs the real CLI (headless Chromium, silent narration).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scrub } from '../src/triage.mjs';
import { startFixture } from './fixture/server.mjs';
import { findVideo, videoName } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.mjs');
let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

const BUNDLE = ['report.md', 'report.json', 'script.json', 'PROMPT.md', 'console.json', 'network.json', 'page/page.json'];
const WITH_PAGE = ['screenshot.png', 'page/aria.yml', 'page/text.txt', 'page/dom.html', 'trace.zip'];

function runCli(args, { env = {} } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [cli, ...args], { windowsHide: true, cwd: root, env: { ...process.env, AFT_OUT_DIR: path.join(os.tmpdir(), 'aft-test-out'), ...env } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code, out }));
  });
}

/** Writes a one-scene tour (plus extras), runs it, and returns the exit code, report.json and run folder. */
async function tour(steps, extra = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-fail-'));
  const file = path.join(dir, 'tour.json');
  const t = { name: 'fixture', baseUrl: app.url, timeouts: { action: 2500, verify: 2500, navigation: 30000, optional: 1000 }, retries: 0,
    scenes: [{ title: 'Fixture', narration: 'Testing.', url: extra.url ?? '/ok', steps }], ...extra };
  delete t.url;
  delete t.env; // the CLI's environment variables, not a tour key
  fs.writeFileSync(file, JSON.stringify(t));
  const out = path.join(dir, 'run');
  const r = await runCli(['run', file, '--speech', 'silent', '--out', out, ...args], { env: extra.env });
  const reportFile = path.join(out, 'report.json');
  return { code: r.code, log: r.out, out, report: fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null };
}

function assertBundle(out, { page = true, stuck = false } = {}) {
  const files = [...BUNDLE, ...(page ? WITH_PAGE : [])].map(f => (stuck && f === 'screenshot.png' ? 'screenshot.txt' : f));
  for (const f of files) assert.ok(fs.existsSync(path.join(out, 'triage', f)), `triage/${f} missing`);
  assert.ok(!fs.existsSync(path.join(out, 'triage', 'INCOMPLETE')), 'bundle marked incomplete');
  assert.equal(findVideo(out), null, 'a failed run must not write a video');
  const md = fs.readFileSync(path.join(out, 'triage', 'report.md'), 'utf8');
  for (const k of ['What failed', 'Why we think so', 'First cause', 'Look next', 'Criteria so far']) assert.match(md, new RegExp(k));
}

describe('failure modes', { concurrency: 3, timeout: 900000 }, () => {
  test('passing run: exit 0, report, no bundle', async () => {
    const r = await tour([{ fill: 'Name', text: 'Ann' }, { click: { role: 'button', name: 'Save' } }, { verify: { text: 'Saved Ann' } }]);
    assert.equal(r.code, 0, r.log);
    assert.equal(r.report.class, 'ok');
    assert.equal(r.report.schema, 'aft-report/1');
    assert.equal(path.basename(findVideo(r.out)), videoName(r.out), 'the video is named after the run');
    assert.ok(!fs.existsSync(path.join(r.out, 'triage')));
  });

  test('locator not found: SCRIPT, exit 2, did-you-mean', async () => {
    const r = await tour([{ fill: 'Nmae', text: 'x' }]);
    assert.equal(r.code, 2, r.log);
    assert.equal(r.report.class, 'script');
    assert.equal(r.report.failing.step, 1);
    assert.ok(r.report.failing.suggestions.includes('Name'), JSON.stringify(r.report.failing.suggestions));
    assert.match(r.log, /SCRIPT: .*did you mean "Name"/);
    assertBundle(r.out);
  });

  test('ambiguous target: warning, not a failure', async () => {
    const r = await tour([{ click: 'Save' }], { url: '/dup' });
    assert.equal(r.code, 0, r.log);
    assert.ok(r.report.warnings.some(w => /ambiguous/.test(w)), JSON.stringify(r.report.warnings));
  });

  test('action blocked by an overlay: SCRIPT, exit 2', async () => {
    const r = await tour([{ click: { role: 'button', name: 'Save' } }], { url: '/overlay' });
    assert.equal(r.code, 2, r.log);
    assert.match(r.report.error, /action blocked: the element is covered by <div\.overlay>/);
    assertBundle(r.out);
  });

  test('disabled element: SCRIPT, exit 2', async () => {
    const r = await tour([{ click: { role: 'button', name: 'Save' } }], { url: '/disabled' });
    assert.equal(r.code, 2, r.log);
    assert.match(r.report.error, /disabled/);
  });

  test('check fails: CRITERION, exit 4, criterion NOT MET', async () => {
    const r = await tour([{ verify: { text: 'Saved Bob' } }], { story: { id: 'FIX-1', acceptanceCriteria: ['It saves'] } });
    assert.equal(r.code, 4, r.log);
    assert.equal(r.report.class, 'criterion');
    assertBundle(r.out);
  });

  test('failing XHR with appErrors.network=fail: APP, exit 5, attributed to the step', async () => {
    const r = await tour([{ click: { role: 'button', name: 'Save' } }, { waitFor: '.toast' }], { url: '/xhr500', appErrors: { network: 'fail' } });
    // The 500 arrives during the click or while waiting for the toast it causes; either way it's named and attributed.
    assert.equal(r.code, 5, r.log);
    assert.equal(r.report.class, 'app');
    assert.match(r.report.error, /GET .*\/api\/fail 500/);
    assert.match(r.report.firstCause.stepKey, /^scene-01#[12]$/);
    assertBundle(r.out);
    const net = fs.readFileSync(path.join(r.out, 'triage', 'network.json'), 'utf8');
    assert.doesNotMatch(net, /abc123secret/, 'token query parameter must be scrubbed');
  });

  test('error toast via tour "errors": APP, exit 5', async () => {
    const r = await tour([{ click: { role: 'button', name: 'Save' } }, { waitFor: '.toast' }, { point: { text: 'Server error' } }],
      { url: '/xhr500', errors: { selector: '.toast', text: 'error' } });
    assert.equal(r.code, 5, r.log);
    assert.match(r.report.error, /something went wrong/);
  });

  test('ignored endpoint: kept but not a cause', async () => {
    const r = await tour([{ click: { role: 'button', name: 'Save' } }, { waitFor: '.toast' }], { url: '/xhr500', appErrors: { network: 'fail', ignore: ['/api/fail'] } });
    assert.equal(r.code, 0, r.log);
  });

  test('uncaught page exception with appErrors.pageErrors=fail: APP, exit 5', async () => {
    const r = await tour([{ click: { role: 'button', name: 'Save' } }, { wait: 0.5 }], { url: '/pageerror', appErrors: { pageErrors: 'fail' } });
    assert.equal(r.code, 5, r.log);
    assert.match(r.report.error, /fixture exploded/);
  });

  test('page never settles (ready.strict): APP, exit 5; not strict: a warning', async () => {
    const strict = await tour([{ point: { text: 'Loading forever' } }], { url: '/busy', ready: { busy: '.spinner', timeout: 1500, strict: true } });
    assert.equal(strict.code, 5, strict.log);
    assert.match(strict.report.error, /never settled/);
    const lax = await tour([{ point: { text: 'Loading forever' } }], { url: '/busy', ready: { busy: '.spinner', timeout: 1500 } });
    assert.equal(lax.code, 0, lax.log);
    assert.ok(lax.report.warnings.some(w => /never settled/.test(w)));
  });

  test('navigation timeout: APP, exit 5', async () => {
    const r = await tour([{ goto: '/hang' }], { timeouts: { navigation: 2000 } });
    assert.equal(r.code, 5, r.log);
    assert.match(r.report.error, /didn't load within 2s/);
    assertBundle(r.out, { stuck: true });
  });

  test('unreachable app: exit 3, bundle written', async () => {
    const r = await tour([{ point: 'Save' }], { baseUrl: 'http://127.0.0.1:9/' });
    assert.equal(r.code, 3, r.log);
    assert.equal(r.report.class, 'unreachable');
    assert.match(r.report.error, /Can't reach/);
    assertBundle(r.out);
  });

  test('bad credentials: LOGIN, exit 6, login screenshot; secret never written', async () => {
    const login = { role: `t${Date.now()}`, signedIn: '#signed-in', steps: [{ goto: '/login' }, { fill: 'User', text: 'ann' },
      { fill: '#pass', text: '{env:AFT_FIX_PASS}', secret: true }, { click: { role: 'button', name: 'Sign in' } }, { waitFor: '#signed-in' }] };
    const r = await tour([{ point: 'Welcome' }], { url: '/secure', login, timeouts: { action: 2500, waitFor: 2500 }, env: { AFT_FIX_PASS: 'wrong-password-xyz' } });
    assert.equal(r.code, 6, r.log);
    assert.equal(r.report.class, 'login');
    assert.ok(fs.existsSync(path.join(r.out, 'triage', 'login-failure.png')));
    for (const f of BUNDLE) assert.doesNotMatch(fs.readFileSync(path.join(r.out, 'triage', f), 'utf8'), /wrong-password-xyz/, `secret in triage/${f}`);
    assert.doesNotMatch(r.log, /wrong-password-xyz/);
  });

  test('good credentials, later failure: password scrubbed from every bundle file', async () => {
    const login = { role: `g${Date.now()}`, signedIn: '#signed-in', steps: [{ goto: '/login' }, { fill: 'User', text: 'ann' },
      { fill: '#pass', text: '{env:AFT_FIX_PASS}', secret: true }, { click: { role: 'button', name: 'Sign in' } }, { waitFor: '#signed-in' }] };
    const r = await tour([{ verify: { text: 'Not there' } }], { url: '/secure', login, env: { AFT_FIX_PASS: 'hunter2-fixture' } });
    assert.equal(r.code, 4, r.log);
    const files = fs.readdirSync(path.join(r.out, 'triage'), { recursive: true }).filter(f => /\.(json|md|yml|txt|html)$/.test(f));
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(r.out, 'triage', f), 'utf8'), /hunter2-fixture/, `secret in triage/${f}`);
  });

  test('expired saved login: signs in again off camera and the run passes', async () => {
    const role = `x${Date.now()}`;
    const stale = path.join(root, 'auth', 'fixture', `${role}.json`);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, JSON.stringify({ cookies: [], origins: [] })); // a session the app no longer accepts
    const login = { role, signedIn: '#signed-in', steps: [{ goto: '/login' }, { fill: 'User', text: 'ann' },
      { fill: '#pass', text: '{env:AFT_FIX_PASS}', secret: true }, { click: { role: 'button', name: 'Sign in' } }, { waitFor: '#signed-in' }] };
    try {
      const r = await tour([{ verify: { text: 'Welcome' } }], { url: '/secure', login, env: { AFT_FIX_PASS: 'hunter2-fixture' } });
      assert.equal(r.code, 0, r.log);
      assert.match(r.log, /saved login expired; signed in again/);
    } finally { fs.rmSync(stale, { force: true }); }
  });

  test('expired saved login without credentials: LOGIN, exit 6, says what to set', async () => {
    const role = `n${Date.now()}`;
    const stale = path.join(root, 'auth', 'fixture', `${role}.json`);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, JSON.stringify({ cookies: [], origins: [] }));
    const login = { role, signedIn: '#signed-in', steps: [{ goto: '/login' }, { fill: '#pass', text: '{env:AFT_FIX_UNSET_PASS}', secret: true }] };
    try {
      const r = await tour([{ verify: { text: 'Welcome' } }], { url: '/secure', login, timeouts: { waitFor: 2000, navigation: 4000 } });
      assert.equal(r.code, 6, r.log);
      assert.match(r.report.error, /credentials missing: set AFT_FIX_UNSET_PASS/);
    } finally { fs.rmSync(stale, { force: true }); }
  });

  test('ffmpeg missing: TOOLING, exit 7, report written', async () => {
    const env = { PATH: path.dirname(process.execPath), Path: path.dirname(process.execPath) };
    const r = await tour([{ point: 'Save' }], { env });
    assert.equal(r.code, 7, r.log);
    assert.equal(r.report.class, 'tooling');
    assert.ok(fs.existsSync(path.join(r.out, 'triage', 'report.md')));
  });
});

describe('redaction', () => {
  test('scrub removes auth headers, cookies, bearer tokens, JWTs and token parameters', () => {
    const s = scrub('Authorization: Bearer abc.def.ghi cookie=session=xyz https://x/cb?code=SECRET1&state=1 {"password":"pw1"} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', ['topsecretvalue']);
    for (const leak of ['abc.def.ghi', 'session=xyz', 'SECRET1', 'pw1', 'eyJzdWIi']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
    assert.equal(scrub('value topsecretvalue here', ['topsecretvalue']), 'value *** here');
    // a one-character dev password is masked as a value, not everywhere
    assert.equal(scrub('pass=1 and 1 item', ['1']), 'pass=*** and 1 item');
  });
});
