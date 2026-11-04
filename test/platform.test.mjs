// Platforms, fragments, fixtures and code steps: composition is checked in-process; classification of code steps
// and fragment failures runs the real CLI against the fixture app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeTour, ConfigError, missingCredentials } from '../src/declarative.mjs';
import { expandSteps, homeOf, initPlatform, loadPlatform } from '../src/platform.mjs';
import { exportTour, importTour } from '../src/exchange.mjs';
import { startFixture } from './fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-plat-'));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };

/** A platforms/ folder with one platform "app" (and whatever else a test adds). */
function makePlatform(baseUrl = 'http://localhost:9/', extra = {}) {
  const dir = path.join(tmp(), 'platforms');
  const p = path.join(dir, 'app');
  write(path.join(p, 'platform.json'), { timeouts: { action: 2500, verify: 2500, navigation: 4000, optional: 1000 }, retries: 0, ignore: ['favicon'], pronounce: { App: 'app' }, ...extra.platform });
  write(path.join(p, 'environments.json'), { default: 'local', local: { baseUrl }, qa: { baseUrl: 'http://qa.example.test/', timeouts: { verify: 9000 } } });
  write(path.join(p, 'login.json'), { default: 'clerk', signedIn: '#me', roles: { clerk: { steps: [{ use: 'sign-in', with: { user: '{env:AFT_TEST_USER}' } }] }, admin: { steps: [{ goto: '/admin-login' }] } } });
  write(path.join(p, 'fragments', 'sign-in.json'), { params: { user: { required: true } }, steps: [{ goto: '/login' }, { fill: 'User', text: '{args.user}' }] });
  write(path.join(p, 'fragments', 'save-name.json'), { params: { name: { required: true }, button: { default: 'Save' } },
    steps: [{ fill: 'Name', text: '{args.name}' }, { click: { role: 'button', name: '{args.button}' } }] });
  write(path.join(p, 'fragments', 'loop-a.json'), { steps: [{ use: 'loop-b' }] });
  write(path.join(p, 'fragments', 'loop-b.json'), { steps: [{ use: 'loop-a' }] });
  write(path.join(p, 'fragments', 'saved.mjs'), `export default async ({ page, args, ctx }) => {
  const text = await page.locator('#out').innerText().catch(() => '');
  if (args.mode === 'throw') throw new Error('code step blew up');
  if (args.mode === 'app') ctx.appError('the save endpoint said no');
  ctx.check(text.includes(args.expect), \`expected "\${args.expect}" in #out, saw "\${text}"\`);
};\n`);
  write(path.join(p, 'fixtures', 'person.json'), { data: { name: 'Ann' }, setup: [{ node: 'seed.mjs' }], teardown: [{ node: 'seed.mjs', args: ['clean'] }] });
  write(path.join(p, 'fixtures', 'seed.mjs'), `import fs from 'node:fs'; import path from 'node:path';
fs.writeFileSync(path.join(process.env.RUN_DIR, process.argv[2] === 'clean' ? 'teardown.txt' : 'setup.txt'), process.cwd());\n`);
  return { dir, p };
}

const tourFile = (dir, t) => { const f = path.join(dir, 'app', 'tours', `${t.name ?? 't'}.tour.json`); write(f, { name: 't', platform: 'app', ...t }); return f; };
const scene = steps => [{ title: 'S', narration: 'Testing.', url: '/ok', steps }];

describe('platforms', () => {
  test('a platform tour gets the environment, role, login steps, fixtures and auth path from the platform', () => {
    const { dir } = makePlatform();
    const file = tourFile(dir, { fixtures: ['person'], scenes: scene([{ use: 'save-name', with: { name: '{data.name}' } }]) });
    const c = composeTour(JSON.parse(fs.readFileSync(file, 'utf8')), { file, toolRoot: root });
    assert.equal(c.env, 'local');
    assert.equal(c.cfg.baseUrl, 'http://localhost:9/');
    assert.equal(c.cfg.login.role, 'clerk');
    assert.equal(c.cfg.login.signedIn, '#me');
    assert.deepEqual(c.cfg.login.steps.map(s => s.from), ['sign-in', 'sign-in']);
    assert.deepEqual(c.cfg.appErrors.ignore, ['favicon']);
    assert.deepEqual(c.cfg.scenes[0].steps, [
      { fill: 'Name', text: 'Ann', from: 'save-name' },
      { click: { role: 'button', name: 'Save' }, from: 'save-name' },
    ]);
    assert.equal(c.cfg.hooks.setup.length, 1);
    assert.equal(c.authFile('clerk'), path.join(root, 'auth', 'app', 'local', 'clerk.json'));
    const qa = composeTour({ name: 't', platform: 'app', role: 'admin', scenes: [] }, { file, toolRoot: root, env: 'qa' });
    assert.equal(qa.cfg.baseUrl, 'http://qa.example.test/');
    assert.equal(qa.cfg.timeouts.verify, 9000);
    assert.equal(qa.cfg.timeouts.action, 2500);
    assert.equal(qa.authFile('admin'), path.join(root, 'auth', 'app', 'qa', 'admin.json'));
  });

  test('login credentials from data: platform, then environment, then fixture (the more specific wins); missing ones named', () => {
    const { dir, p } = makePlatform();
    write(path.join(p, 'platform.json'), { data: { user: 'plat-user', pass: '{env:AFT_TEST_PASS}', other: 'x' } });
    write(path.join(p, 'environments.json'), { default: 'local', local: { baseUrl: 'http://localhost:9/' }, qa: { baseUrl: 'http://qa.example.test/', data: { user: 'qa-user' } } });
    write(path.join(p, 'login.json'), { default: 'clerk', roles: { clerk: { steps: [{ fill: 'User', text: '{data.user}' }, { fill: 'Pass', text: '{data.pass}', secret: true }, { fill: 'X', text: '{data.nope}' }] } } });
    write(path.join(p, 'fixtures', 'as-ann.json'), { data: { user: 'ann' } });
    const file = tourFile(dir, { scenes: [] });
    const texts = c => c.cfg.login.steps.map(s => s.text);
    const local = composeTour({ name: 't', platform: 'app', scenes: [] }, { file, toolRoot: root });
    assert.deepEqual(texts(local), ['plat-user', '{env:AFT_TEST_PASS}', '{data.nope}']);
    assert.equal(local.cfg.data.other, 'x');
    assert.deepEqual(texts(composeTour({ name: 't', platform: 'app', scenes: [] }, { file, toolRoot: root, env: 'qa' })).slice(0, 1), ['qa-user']);
    assert.deepEqual(texts(composeTour({ name: 't', platform: 'app', fixtures: ['as-ann'], scenes: [] }, { file, toolRoot: root, env: 'qa' })).slice(0, 1), ['ann']);
    delete process.env.AFT_TEST_PASS;
    const missing = missingCredentials(local.cfg.login.steps);
    assert.equal(missing.length, 2);
    assert.match(missing[0], /AFT_TEST_PASS/);
    assert.match(missing[1], /data\.nope/);
  });

  test('a platform tour may not carry URLs, credentials, launch commands or app-wide settings', () => {
    const { dir } = makePlatform();
    for (const bad of [{ baseUrl: 'http://x/' }, { login: {} }, { launch: { command: 'x' } }, { errors: {} }, { ready: {} }]) {
      const file = tourFile(dir, { ...bad, scenes: scene([]) });
      assert.throws(() => composeTour(JSON.parse(fs.readFileSync(file, 'utf8')), { file, toolRoot: root }), e => e instanceof ConfigError && /belongs in the platform/.test(e.message));
    }
    const file = tourFile(dir, { scenes: [{ title: 'S', narration: 'n', url: 'https://elsewhere.example/', steps: [] }] });
    assert.throws(() => composeTour(JSON.parse(fs.readFileSync(file, 'utf8')), { file, toolRoot: root }), /absolute URLs/);
  });

  test('unknown platform, environment, role, fixture or fragment: a config error naming what exists', () => {
    const { dir } = makePlatform();
    const t = extra => { const file = tourFile(dir, { scenes: scene([]), ...extra }); return () => composeTour(JSON.parse(fs.readFileSync(file, 'utf8')), { file, toolRoot: root }); };
    assert.throws(t({ platform: 'nope' }), /No platform "nope".*has: app/s);
    assert.throws(t({ env: 'prod' }), /no environment "prod" \(has: local, qa\)/);
    assert.throws(t({ role: 'chief' }), /no login role "chief" \(has: clerk, admin\)/);
    assert.throws(t({ fixtures: ['missing'] }), /no fixture "missing"/);
    assert.throws(t({ scenes: scene([{ use: 'nothing' }]) }), /No fragment "nothing"/);
  });

  test('fragments: required and unknown parameters, defaults, nesting, cycles, values passed as is', () => {
    const { p } = makePlatform();
    const dirs = [path.join(p, 'fragments')];
    assert.throws(() => expandSteps([{ use: 'save-name' }], { dirs }), /needs "with": \{ "name"/);
    assert.throws(() => expandSteps([{ use: 'save-name', with: { name: 'x', nmae: 'y' } }], { dirs }), /no parameter "nmae"/);
    assert.equal(expandSteps([{ use: 'save-name', with: { name: 'x', button: 'Go' } }], { dirs })[1].click.name, 'Go');
    assert.throws(() => expandSteps([{ use: 'loop-a' }], { dirs }), /Fragment cycle: loop-a.json → loop-b.json → loop-a.json/);
    // A whole-string placeholder passes an object (a target) through unchanged; extra keys on the call apply to each step.
    write(path.join(p, 'fragments', 'press-on.json'), { params: { target: {} }, steps: [{ click: '{args.target}' }] });
    assert.deepEqual(expandSteps([{ use: 'press-on', with: { target: { role: 'link', name: 'Home' } }, optional: true }], { dirs }),
      [{ click: { role: 'link', name: 'Home' }, optional: true, from: 'press-on' }]);
    const code = expandSteps([{ use: 'saved', with: { expect: 'x' } }], { dirs })[0];
    assert.equal(code.code, path.join(p, 'fragments', 'saved.mjs'));
    assert.deepEqual(code.with, { expect: 'x' });
  });

  test('aft platform init scaffolds every file once, and the result loads', () => {
    const dir = tmp();
    const p = initPlatform(dir, 'newapp', { baseUrl: 'http://localhost:5000/' });
    for (const f of ['platform.json', 'environments.json', 'login.json', 'requirements.mjs', 'README.md', 'tours/smoke.tour.json', 'fragments', 'fixtures'])
      assert.ok(fs.existsSync(path.join(p, f)), f);
    assert.throws(() => initPlatform(dir, 'newapp'), /already exists/);
    process.env.AFT_PLATFORMS = dir;
    try {
      const pl = loadPlatform(root, 'newapp');
      assert.equal(pl.defaultEnv, 'local');
      assert.equal(pl.environments.local.baseUrl, 'http://localhost:5000/');
    } finally { delete process.env.AFT_PLATFORMS; }
  });

  test('export → import: fragments inlined, code files carried, {data.x} kept, missing fixtures named, no overwrite', () => {
    const { dir } = makePlatform();
    const file = tourFile(dir, { name: 'ex', env: 'qa', fixtures: ['person', 'other'], scenes: scene([
      { use: 'save-name', with: { name: '{data.name}' } }, { use: 'saved', with: { expect: 'x' } }]) });
    const { doc } = exportTour(file, { toolRoot: root, outRoot: tmp() });
    assert.equal(doc.schema, 'aft-export/1');
    assert.equal(doc.source.platform, 'app');
    assert.equal(doc.source.env, 'qa');
    assert.equal(doc.tour.platform, undefined);
    assert.deepEqual(doc.tour.scenes[0].steps.slice(0, 2), [
      { fill: 'Name', text: '{data.name}', comment: 'from fragment save-name' },
      { click: { role: 'button', name: 'Save' }, comment: 'from fragment save-name' }]);
    assert.equal(doc.tour.scenes[0].steps[2].code, 'saved.mjs');
    assert.ok(doc.files['saved.mjs'].base64);
    const bundle = path.join(tmp(), 'ex.aft.json');
    write(bundle, doc);
    process.env.AFT_PLATFORMS = dir;
    try {
      const r = importTour(bundle, { toolRoot: root, platform: 'app', name: 'ex-imported' });
      assert.deepEqual(r.missing, ['fixture "other" (platforms/app/fixtures/other.json)']);
      const t = JSON.parse(fs.readFileSync(r.tour, 'utf8'));
      assert.equal(t.platform, 'app');
      assert.equal(t.scenes[0].steps[2].code, 'ex-imported-files/saved.mjs');
      assert.match(t.comment, /Imported from app \(qa\)/);
      assert.ok(fs.existsSync(path.join(path.dirname(r.tour), 'ex-imported-files', 'saved.mjs')));
      assert.throws(() => importTour(bundle, { toolRoot: root, platform: 'app', name: 'ex-imported' }), /exists; pass --force/);
      write(path.join(dir, 'app', 'fixtures', 'other.json'), { data: {} });
      const again = importTour(bundle, { toolRoot: root, platform: 'app', name: 'ex-imported', force: true });
      assert.deepEqual(again.missing, []);
      // It loads as a tour of the target platform: code resolves next to it, data from the fixtures.
      const c = composeTour(JSON.parse(fs.readFileSync(again.tour, 'utf8')), { file: again.tour, toolRoot: root });
      assert.equal(c.cfg.scenes[0].steps[0].text, 'Ann');
      assert.ok(c.cfg.scenes[0].steps[2].code.endsWith(path.join('ex-imported-files', 'saved.mjs')));
    } finally { delete process.env.AFT_PLATFORMS; }
  });
});

// ---- Through the CLI ---------------------------------------------------------------------------------------------

let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

function runCli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args], { cwd: root, env: { ...process.env, AFT_OUT_DIR: path.join(os.tmpdir(), 'aft-test-out'), ...env } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code, out }));
  });
}

async function runTour(steps, extra = {}) {
  const { dir } = makePlatform(app.url + '/');
  // No login on the fixture app.
  fs.rmSync(path.join(dir, 'app', 'login.json'));
  const file = tourFile(dir, { scenes: scene(steps), ...extra });
  const out = path.join(tmp(), 'run');
  const r = await runCli(['run', file, '--speech', 'silent', '--out', out]);
  const rf = path.join(out, 'report.json');
  return { code: r.code, log: r.out, out, report: fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : null };
}

describe('code steps and fragments in a run', { concurrency: 3, timeout: 600000 }, () => {
  const save = [{ use: 'save-name', with: { name: '{data.name}' } }];

  test('fragments, fixture data and hooks, and a passing code check: exit 0', async () => {
    const r = await runTour([...save, { use: 'saved', with: { expect: 'Saved {data.name}' } }], { fixtures: ['person'] });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.report.class, 'ok');
    assert.ok(fs.existsSync(path.join(r.out, 'setup.txt')) && fs.existsSync(path.join(r.out, 'teardown.txt')), 'fixture hooks ran');
    assert.match(fs.readFileSync(path.join(r.out, 'setup.txt'), 'utf8'), /fixtures$/, 'fixture hooks run from the fixture folder');
  });

  test('code step ctx.check fails: CRITERION, exit 4, criteria attached', async () => {
    const r = await runTour([...save, { use: 'saved', with: { expect: 'Saved Bob' }, criterion: 2 }], { fixtures: ['person'] });
    assert.equal(r.code, 4, r.log);
    assert.equal(r.report.class, 'criterion');
    assert.deepEqual(r.report.failing.criteria, ['2']);
    assert.match(r.report.failing.error, /expected "Saved Bob"/);
  });

  test('code step throws: SCRIPT, exit 2; ctx.appError: APP, exit 5', async () => {
    const [s, a] = await Promise.all([
      runTour([{ use: 'saved', with: { mode: 'throw' } }]),
      runTour([{ use: 'saved', with: { mode: 'app' } }]),
    ]);
    assert.equal(s.code, 2, s.log);
    assert.match(s.report.failing.error, /code step blew up/);
    assert.equal(s.report.failing.spec.code, 'saved.mjs');
    assert.equal(a.code, 5, a.log);
    assert.equal(a.report.class, 'app');
  });

  test('a failing step inside a fragment names the fragment', async () => {
    const r = await runTour([{ use: 'save-name', with: { name: 'x', button: 'Svae' } }]);
    assert.equal(r.code, 2, r.log);
    assert.equal(r.report.failing.from, 'save-name');
    assert.match(r.log, /fragment save-name/);
  });

  test('a launched app that exits with an error: UNREACHABLE at once, with the end of its log', async () => {
    const { dir } = makePlatform('http://127.0.0.1:9/');
    fs.rmSync(path.join(dir, 'app', 'login.json'));
    write(path.join(dir, 'app', 'environments.json'), { default: 'local', local: { baseUrl: 'http://127.0.0.1:9/',
      launch: [{ name: 'crashy', command: 'node -e "console.error(\'There is already an object named Lines\'); process.exit(3)"', timeoutSeconds: 120 }] } });
    const file = tourFile(dir, { scenes: scene([]) });
    const started = Date.now();
    const r = await runCli(['run', file, '--speech', 'silent', '--out', path.join(tmp(), 'run')]);
    assert.equal(r.code, 3, r.out);
    assert.ok(Date.now() - started < 60000, 'did not wait out the 120 s timeout');
    assert.match(r.out, /crashy exited with code 3/);
    assert.match(r.out, /already an object named Lines/);
  });

  test('platform init --no-login and a smoke tour from the start page', async () => {
    const home = await homeOf(`${app.url}/ok`);
    assert.deepEqual(home, { title: 'OK', heading: 'Fixture' });
    assert.equal(await homeOf('http://127.0.0.1:9/'), null);
    const dir = tmp();
    const p = initPlatform(dir, 'nologin', { baseUrl: `${app.url}/ok`, login: false, home });
    assert.ok(!fs.existsSync(path.join(p, 'login.json')));
    const smoke = JSON.parse(fs.readFileSync(path.join(p, 'tours', 'smoke.tour.json'), 'utf8'));
    assert.deepEqual(smoke.scenes[0].steps, [{ verify: { role: 'heading', name: 'Fixture' } }, { verify: { title: 'OK' } }]);
    const q = initPlatform(dir, 'unknown', {});
    assert.ok(fs.existsSync(path.join(q, 'login.json')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(q, 'tours', 'smoke.tour.json'), 'utf8')).scenes[0].steps[0].verify, { role: 'heading', nth: 0 });
  });

  test('attach-only environment that is down: UNREACHABLE, exit 3', async () => {
    const { dir } = makePlatform('http://127.0.0.1:9/');
    fs.rmSync(path.join(dir, 'app', 'login.json'));
    write(path.join(dir, 'app', 'environments.json'), { default: 'local', local: { baseUrl: 'http://127.0.0.1:9/', attach: [{ name: 'app' }] } });
    const file = tourFile(dir, { scenes: scene([]) });
    const r = await runCli(['run', file, '--speech', 'silent', '--out', path.join(tmp(), 'run')]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /attach-only/);
  });
});
