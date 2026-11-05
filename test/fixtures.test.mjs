// Repeatable runs (paired fixture items, the ledger, aft cleanup), artifacts (pin, references, cleanup), off-camera
// scenes and steps, run tags and shared environments. Runs the real CLI against the fixture app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { trimPlan } from '../src/render.mjs';
import { fillArtifacts } from '../src/steps.mjs';
import { Ledger, parseAge, runTag, undoAll } from '../src/ledger.mjs';
import { pinSuggestions } from '../src/review.mjs';
import { startFixture } from './fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-fx-'));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// A hook script with a tiny "database" of files in AFT_TEST_STATE: create / delete / check / fail <name>.
const ITEM = `import fs from 'node:fs'; import path from 'node:path';
const [op, name] = process.argv.slice(2); const dir = process.env.AFT_TEST_STATE; fs.mkdirSync(dir, { recursive: true });
const f = path.join(dir, name); fs.appendFileSync(path.join(dir, 'log.txt'), op + ' ' + name + '\\n');
if (op === 'create') fs.writeFileSync(f, process.env.RUN_TAG ?? '');
else if (op === 'delete') { if (!fs.existsSync(f)) process.exit(3); fs.rmSync(f); }
else if (op === 'check') process.exit(fs.existsSync(f) ? 0 : 1);
else if (op === 'fail') process.exit(1);
else if (op === 'json') console.log(JSON.stringify({ id: 'acct-7', password: 'pw-very-secret-77' }));
`;
const hook = (op, name) => ({ node: 'item.mjs', args: [op, name] });

let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

/** A platform "app" on the fixture server (no login), with fixtures; env extra merged into "local". */
function makePlatform({ fixtures = {}, env = {} } = {}) {
  const dir = path.join(tmp(), 'platforms');
  const p = path.join(dir, 'app');
  write(path.join(p, 'platform.json'), { timeouts: { action: 5000, verify: 5000, navigation: 30000, optional: 1000 }, retries: 0, ignore: ['favicon'] });
  write(path.join(p, 'environments.json'), { default: 'local', local: { baseUrl: app.url + '/', ...env } });
  write(path.join(p, 'fixtures', 'item.mjs'), ITEM);
  for (const [n, f] of Object.entries(fixtures)) write(path.join(p, 'fixtures', `${n}.json`), f);
  return { dir, p };
}

function cli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args], { windowsHide: true, cwd: root, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => resolve({ code, out, err, log: out + err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
  });
}

/** Runs a tour of the platform (validate by default) with its own out folder and state folder. */
async function runTour(t, { command = 'validate', platform, args = [], outRoot = tmp(), state = tmp() } = {}) {
  const { dir } = platform ?? makePlatform();
  const name = t.name ?? `fx-${Math.random().toString(36).slice(2, 7)}`;
  const file = path.join(dir, 'app', 'tours', `${name}.tour.json`);
  write(file, { name, platform: 'app', ...t });
  const r = await cli([command, file, '--json', ...(command === 'run' ? ['--speech', 'silent'] : []), ...args], { AFT_OUT_DIR: outRoot, AFT_TEST_STATE: state });
  const runDir = r.json?.runDir;
  const j = f => (runDir && fs.existsSync(path.join(runDir, f)) ? readJson(path.join(runDir, f)) : null);
  return { ...r, runDir, file, name, outRoot, state, dir, ledger: j('ledger.json'), report: j('report.json'), validation: j('validation.json'), artifacts: j('artifacts.json'),
    log: r.log, statelog: () => (fs.existsSync(path.join(state, 'log.txt')) ? fs.readFileSync(path.join(state, 'log.txt'), 'utf8').trim().split(/\r?\n/) : []) };
}

const okScene = (steps = [{ verify: { role: 'heading', name: 'Fixture' } }], extra = {}) => [{ title: 'S', narration: 'Testing.', url: '/ok', steps, ...extra }];

describe('fixture items and the ledger', { concurrency: 1, timeout: 900000 }, () => {
  test('items run in order and are undone in reverse; a failing setup undoes only what ran', async () => {
    const platform = makePlatform({ fixtures: { data: { items: [
      { name: 'a', setup: hook('create', 'a'), teardown: hook('delete', 'a') },
      { name: 'b', setup: hook('fail', 'b'), teardown: hook('delete', 'b') },
      { name: 'c', setup: hook('create', 'c'), teardown: hook('delete', 'c') },
    ] } } });
    const r = await runTour({ fixtures: ['data'], scenes: okScene() }, { platform });
    assert.notEqual(r.code, 0, r.log);
    assert.deepEqual(r.statelog(), ['create a', 'fail b', 'delete a']);
    assert.deepEqual(r.ledger.items.map(i => [i.name, i.status]), [['a', 'undone'], ['b', 'failed']]);
    const run = readJson(path.join(r.runDir, 'run.json'));
    assert.equal(run.status, 'failed');
  });

  test('a check that holds skips setup ("already in place"); a check still failing after setup is a SCRIPT failure', async () => {
    const platform = makePlatform({ fixtures: {
      there: { items: [{ name: 'x', check: hook('check', 'x'), setup: hook('create', 'x'), teardown: hook('delete', 'x') }] },
      broken: { items: [{ name: 'y', check: hook('check', 'never'), setup: hook('create', 'y'), teardown: hook('delete', 'y') }] },
    } });
    const state = tmp();
    fs.writeFileSync(path.join(state, 'x'), 'seeded');
    const [held, broken] = await Promise.all([
      runTour({ fixtures: ['there'], scenes: okScene() }, { platform, state }),
      runTour({ fixtures: ['broken'], scenes: okScene() }, { platform }),
    ]);
    assert.equal(held.code, 0, held.log);
    assert.deepEqual(held.ledger.items.map(i => [i.name, i.status]), [['x', 'in-place']]);
    assert.ok(fs.existsSync(path.join(state, 'x')), 'data already in place is never undone');
    assert.ok(!held.statelog().includes('create x'));
    assert.deepEqual(held.validation.fixtures.map(f => f.status), ['in-place']);
    assert.equal(broken.code, 2, broken.log);
    assert.match(broken.json.error.message, /SETUP: fixture item "y".*check still fails/);
    assert.ok(broken.statelog().includes('delete y'), 'what the failed setup created is still undone');
  });

  test('older setup/teardown lists still work: teardown after every setup ran', async () => {
    const platform = makePlatform({ fixtures: { old: { setup: [hook('create', 'o1'), hook('create', 'o2')], teardown: [hook('delete', 'o2'), hook('delete', 'o1')] } } });
    const r = await runTour({ fixtures: ['old'], scenes: okScene() }, { platform });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.statelog(), ['create o1', 'create o2', 'delete o2', 'delete o1']);
  });

  test('a run killed mid-way leaves pending undo in ledger.json; aft cleanup finishes it; a rerun starts by finishing it', async () => {
    const platform = makePlatform({ fixtures: { data: { items: [{ name: 'k', setup: hook('create', 'k'), teardown: hook('delete', 'k') }] } } });
    const outRoot = tmp(), state = tmp();
    const name = 'fx-kill';
    const file = path.join(platform.dir, 'app', 'tours', `${name}.tour.json`);
    write(file, { name, platform: 'app', fixtures: ['data'], scenes: okScene([{ wait: 60 }]) });
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), 'validate', file], { windowsHide: true, cwd: root, env: { ...process.env, AFT_OUT_DIR: outRoot, AFT_TEST_STATE: state }, stdio: 'ignore' });
    const ledgerFile = () => { const b = path.join(outRoot, name); return fs.existsSync(b) ? fs.readdirSync(b).map(d => path.join(b, d, 'ledger.json')).find(f => fs.existsSync(f)) : null; };
    for (let i = 0; i < 120 && !(ledgerFile() && readJson(ledgerFile()).items[0]?.status === 'done'); i++) await new Promise(r => setTimeout(r, 500));
    await new Promise(r => setTimeout(r, 1500));
    p.kill('SIGKILL');
    await new Promise(r => p.on('exit', r));
    const lf = ledgerFile();
    assert.equal(readJson(lf).items[0].status, 'done');
    assert.ok(fs.existsSync(path.join(state, 'k')), 'the kill left the data behind');

    const list = await cli(['cleanup', '--json'], { AFT_OUT_DIR: outRoot, AFT_TEST_STATE: state });
    assert.equal(list.json.data.pending.length, 1, list.log);
    assert.ok(fs.existsSync(path.join(state, 'k')), 'listing changes nothing');

    // A rerun of the same tour finishes the earlier run's undo before its own setup.
    const again = await runTour({ name, fixtures: ['data'], scenes: okScene() }, { platform, outRoot, state });
    assert.equal(again.code, 0, again.log);
    assert.match(again.log, /earlier run\(s\) of this tour left data behind/);
    assert.equal(readJson(lf).items[0].status, 'undone');
    assert.deepEqual(again.statelog(), ['create k', 'delete k', 'create k', 'delete k']);
  });

  test('aft cleanup <run> runs pending hook undo', async () => {
    const outRoot = tmp(), state = tmp();
    const dir = path.join(outRoot, 'x', '20261105-101010-abcd');
    fs.mkdirSync(dir, { recursive: true });
    const fx = path.join(tmp(), 'item.mjs');
    fs.writeFileSync(fx, ITEM);
    fs.writeFileSync(path.join(state, 'z'), '');
    const l = new Ledger(path.join(dir, 'ledger.json'), { tour: 'x', tourDir: path.dirname(fx), baseUrl: app.url, tag: runTag(dir) });
    l.add({ name: 'z', kind: 'hook', status: 'done', undo: { hooks: [{ node: fx, args: ['delete', 'z'] }] } });
    const r = await cli(['cleanup', dir, '--json'], { AFT_OUT_DIR: outRoot, AFT_TEST_STATE: state });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.json.data.cleaned[0].undone, 1);
    assert.ok(!fs.existsSync(path.join(state, 'z')));
    assert.equal(readJson(path.join(dir, 'ledger.json')).items[0].status, 'undone');
    assert.equal(runTag(dir), 'aft-1105-abcd');
    // --tag filters by run tag; nothing is left to do now.
    const none = await cli(['cleanup', '--tag', 'aft-1105', '--json'], { AFT_OUT_DIR: outRoot });
    assert.deepEqual(none.json.data.pending, []);
  });
});

describe('artifacts', { concurrency: 1, timeout: 900000 }, () => {
  const create = customer => [{ goto: '/orders/new' }, { fill: 'Customer', text: customer }, { click: { role: 'button', name: 'Create' } }];

  test('pin: fields from the page, references by name and role, secrets masked, cleanup in the browser', async () => {
    const r = await runTour({ scenes: [{ title: 'Create', narration: 'An order is created.', url: '/orders/new', steps: [
      ...create('Ann {run.tag}'),
      { pin: 'newOrder', role: 'order', fields: { id: { capture: { url: true }, pattern: '/orders/(\\w+)' }, customer: '#customer', code: { value: 'sekret-code-9911' } }, secret: ['code'],
        cleanup: [{ goto: '/orders/{artifact.newOrder.id}' }, { click: { role: 'button', name: 'Delete' } }, { verify: { text: 'Deleted' } }] },
      { verify: { role: 'heading', name: 'Order {artifact.newOrder.id}' } },
      { verify: '#customer', text: '{artifact[order].customer}' },
    ] }] }, { command: 'run' });
    assert.equal(r.code, 0, r.log);
    const a = r.artifacts.artifacts[0];
    assert.equal(a.name, 'newOrder');
    assert.equal(a.role, 'order');
    assert.equal(a.fields.code, '***');
    assert.match(a.fields.customer, /^Ann aft-\d{4}-[a-z0-9]+$/, 'the run tag is filled in');
    assert.equal(a.scene, 'scene-01');
    assert.equal(a.scriptStep, 4);
    assert.equal(a.cleanup, 'undone');
    assert.ok(a.shot && fs.existsSync(path.join(r.runDir, a.shot)), 'a cropped still of where it came from');
    const left = await (await fetch(`${app.url}/api/orders`)).json();
    assert.ok(/^\d+$/.test(a.fields.id) && !left.some(o => o.id === a.fields.id), 'the cleanup deleted it');
    for (const f of ['report.json', 'report.md', 'artifacts.json']) assert.ok(!fs.readFileSync(path.join(r.runDir, f), 'utf8').includes('sekret-code-9911'), `${f} has no secret`);
    assert.equal(r.report.artifacts[0].cleanup, 'undone');
    assert.match(fs.readFileSync(path.join(r.runDir, 'report.md'), 'utf8'), /## Artifacts/);
  });

  test('an unknown artifact is a SCRIPT failure; a failing cleanup is leftover data with a review finding', async () => {
    const [unknown, leftover] = await Promise.all([
      runTour({ scenes: okScene([{ fill: 'Name', text: '{artifact.nothing.id}' }]) }, { command: 'run' }),
      runTour({ scenes: [{ title: 'Create', narration: 'An order.', url: '/orders/new', steps: [...create('Bob'),
        { pin: 'o', fields: { id: { capture: { url: true }, pattern: '/orders/(\\w+)' } }, cleanup: [{ click: { role: 'button', name: 'No such button' } }] }] }] }, { command: 'run' }),
    ]);
    assert.equal(unknown.code, 2, unknown.log);
    assert.match(unknown.json.error.message, /no artifact "nothing"/);
    assert.equal(leftover.code, 0, leftover.log);
    assert.equal(leftover.report.fixtures.find(f => f.kind === 'artifact').status, 'undo-failed');
    const f = leftover.report.review.findings.find(x => x.kind === 'leftover');
    assert.ok(f && f.id === 'leftover|artifact o', JSON.stringify(leftover.report.review.findings));
    assert.equal(leftover.report.review.verdict, 'needs-review');
    const list = await cli(['cleanup', '--json'], { AFT_OUT_DIR: leftover.outRoot });
    assert.equal(list.json.data.pending[0].items[0].status, 'undo-failed');
  });

  test('a setup hook can pin what it created; the review suggests pinning a new record', async () => {
    const platform = makePlatform({ fixtures: { acct: { items: [{ name: 'account', setup: { node: 'item.mjs', args: ['json', 'a'], output: 'json', pin: 'account', role: 'account', secret: ['password'] } }] } } });
    const r = await runTour({ fixtures: ['acct'], scenes: [{ title: 'S', narration: 'x', url: '/orders/new', steps: [...create('Cy'), { verify: { role: 'heading', name: 'Order', exact: false } }] },
      { title: 'T', narration: 'y', url: '/ok', steps: [{ fill: 'Name', text: '{artifact[account].id}' }, { click: 'Save' }, { verify: '#out', text: 'Saved acct-7' }] }] }, { platform });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.validation.artifacts.map(a => [a.name, a.source, a.fields.password]), [['account', 'setup', '***']]);
    const s = r.validation.review.findings.find(x => x.kind === 'suggest-pin');
    assert.ok(s, JSON.stringify(r.validation.review.findings));
    assert.equal(s.proposal.insertAfter, 3);
    assert.deepEqual(s.proposal.step.fields.id, { capture: { url: true }, pattern: '/orders/([^/?#]+)' });
    assert.ok(!fs.readFileSync(path.join(r.runDir, 'validation.json'), 'utf8').includes('pw-very-secret-77'));
  });

  test('fillArtifacts and pinSuggestions', () => {
    const arts = [{ name: 'a1', role: 'account', fields: { id: '1' } }, { name: 'a2', role: 'account', fields: { id: '2' } }];
    assert.equal(fillArtifacts('{artifact.a1.id}/{artifact[account].id}', arts), '1/2');
    assert.throws(() => fillArtifacts('{artifact.a1.nope}', arts), /has no field "nope" \(has: id\)/);
    assert.throws(() => fillArtifacts('{artifact[case].id}', arts), /no artifact with role "case"/);
    const steps = [{ scene: 'scene-01', step: 1, action: 'click', ok: true, url: 'http://x/cases/9/edit' }, { scene: 'scene-01', step: 2, action: 'click', ok: true, url: 'http://x/cases/9/edit' }];
    assert.deepEqual(pinSuggestions({ scenes: [{ steps: [{}, {}] }] }, steps), [], 'an id already on screen is not new');
    assert.equal(pinSuggestions({ scenes: [{ steps: [{}, {}, { pin: 'x', fields: {} }] }] }, [{ ...steps[0], url: 'http://x/cases' }, steps[1]]).length, 0, 'pinned later in the scene');
  });
});

describe('off camera', { concurrency: 1, timeout: 900000 }, () => {
  test('an off-camera scene leaves no clip and no caption, and its checks still count; an off-camera step is cut', async () => {
    const r = await runTour({ story: { acceptanceCriteria: ['The fixture shows its heading', 'Saving works'] }, scenes: [
      { title: 'Prepare', camera: false, url: '/ok', criteria: [1], steps: [{ verify: { role: 'heading', name: 'Fixture' } }] },
      { title: 'Save', narration: 'We save a name.', url: '/ok', criteria: [2], steps: [{ fill: 'Name', text: 'Di' }, { wait: 2.5, camera: false }, { click: 'Save' }, { verify: '#out', text: 'Saved Di' }] },
    ] }, { command: 'run' });
    assert.equal(r.code, 0, r.log);
    assert.ok(!fs.existsSync(path.join(r.runDir, 'clips', 'scene-01.mp4')), 'no clip for the off-camera scene');
    assert.ok(fs.existsSync(path.join(r.runDir, 'clips', 'scene-02.mp4')));
    assert.ok(!fs.existsSync(path.join(r.runDir, 'scene-01.wav')), 'no narration for it');
    const vtt = fs.readFileSync(path.join(r.runDir, 'tour.vtt'), 'utf8');
    assert.equal((vtt.match(/-->/g) ?? []).length, 1, vtt);
    assert.deepEqual(r.report.criteria.map(c => [c.id, c.status]), [['1', 'met'], ['2', 'met']]);
    assert.ok(r.report.steps.filter(s => s.scene === 'scene-01').every(s => s.offCamera), 'reported as off camera');
    const timings = readJson(path.join(r.runDir, 'timings.json'));
    assert.deepEqual(timings.scenes.map(s => s.id), ['scene-02']);
    const off = timings.scenes[0].waits.filter(w => w.reason === 'offCamera');
    assert.equal(off.length, 1);
    assert.ok(off[0].end - off[0].start >= 2.4);
    assert.ok(fs.existsSync(path.join(r.runDir, 'screens', 'scene-01.png')), 'the storyboard still has a still for it');
  });

  test('trimPlan always cuts off-camera windows, whole, even with trimming off', () => {
    const scene = { start: 10, end: 30, waits: [{ reason: 'offCamera', start: 12, end: 13 }, { reason: 'ready', start: 20, end: 25 }] };
    const off = trimPlan(scene, { mode: 'off' });
    assert.deepEqual(off.windows.map(w => [w.start, w.end]), [[12, 13]]);
    assert.equal(off.saved, 1);
    const sped = trimPlan(scene, { mode: 'speed', speed: 4, over: 1.5, leadIn: 0.3 });
    assert.deepEqual(sped.windows.map(w => [w.start, w.end, !!w.drop]), [[12, 13, true], [20.3, 25, false]]);
    assert.equal(+sped.saved.toFixed(3), +(1 + 4.7 * 0.75).toFixed(3));
    assert.equal(sped.map(14), 13);
  });

  test('a scene without narration must be off camera', async () => {
    const r = await runTour({ scenes: [{ title: 'S', url: '/ok', steps: [] }] });
    assert.equal(r.code, 1, r.log);
    assert.match(r.log, /narration is required \(or "camera": false/);
  });
});

describe('shared environments, reset, and run status', { concurrency: 1, timeout: 900000 }, () => {
  test('a shared environment warns about data created without {run.tag}; reset is refused there', async () => {
    const platform = makePlatform({ env: { shared: true, reset: [{ run: 'node -e "0"' }] }, fixtures: {
      untagged: { items: [{ name: 'u', setup: hook('create', 'u'), teardown: hook('delete', 'u') }] },
      tagged: { items: [{ name: 't', setup: { node: 'item.mjs', args: ['create', 't-{run.tag}'] }, teardown: { node: 'item.mjs', args: ['delete', 't-{run.tag}'] } }] },
    } });
    const [u, t, reset] = await Promise.all([
      runTour({ fixtures: ['untagged'], scenes: okScene() }, { platform }),
      runTour({ fixtures: ['tagged'], scenes: okScene() }, { platform }),
      cli(['reset', '--platform', 'app', '--json'], { AFT_PLATFORMS: platform.dir, AFT_OUT_DIR: tmp() }),
    ]);
    assert.equal(u.code, 0, u.log);
    assert.match(u.validation.warnings.join('\n'), /fixture item "u" creates data without \{run\.tag\}/);
    assert.deepEqual(t.validation.warnings, []);
    assert.match(t.statelog()[0], /^create t-aft-\d{4}-[a-z0-9]+$/, 'hooks get {run.tag} filled in');
    assert.equal(reset.code, 1, reset.log);
    assert.match(reset.json.error.message, /is shared: it is never reset/);
  });

  test('reset runs the environment hooks; --reset runs them before a run', async () => {
    const state = tmp();
    const platform = makePlatform({ env: { reset: [{ node: path.join(platform0(), 'item.mjs'), args: ['create', 'reset-marker'] }] } });
    function platform0() { const d = tmp(); fs.writeFileSync(path.join(d, 'item.mjs'), ITEM); return d; }
    const r = await runTour({ scenes: okScene() }, { platform, state, args: ['--reset'] });
    assert.equal(r.code, 0, r.log);
    assert.ok(fs.existsSync(path.join(state, 'reset-marker')));
  });

  test('a failing dry run is recorded as failed (run.json, runs.jsonl), and latest.json is not moved', async () => {
    const r = await runTour({ scenes: okScene([{ click: 'No such thing' }]) });
    assert.equal(r.code, 2, r.log);
    const run = readJson(path.join(r.runDir, 'run.json'));
    assert.equal(run.status, 'failed');
    assert.equal(run.class, 'script');
    assert.ok(!fs.existsSync(path.join(path.dirname(r.runDir), 'latest.json')));
  });

  test('platform check --json: not ready is ok false, exit 1, with the stages', async () => {
    const dir = path.join(tmp(), 'platforms');
    write(path.join(dir, 'down', 'environments.json'), { default: 'local', local: { baseUrl: 'http://127.0.0.1:9/' } });
    write(path.join(dir, 'down', 'platform.json'), {});
    const r = await cli(['platform', 'check', 'down', '--json'], { AFT_PLATFORMS: dir, AFT_OUT_DIR: tmp() });
    assert.equal(r.code, 1, r.log);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.data.ok, false);
    assert.ok(r.json.data.results.some(x => x.label === 'reachable' && !x.ok));
  });

  test('ledger helpers', async () => {
    assert.equal(parseAge('2d'), 2 * 864e5);
    assert.equal(parseAge('nope'), null);
    const l = new Ledger(null, {});
    const done = [];
    l.add({ name: 'h', kind: 'hook', status: 'done', undo: { hooks: [1] } });
    l.add({ name: 's', kind: 'steps', status: 'done', undo: { steps: [1] } });
    const r = await undoAll(l, { undoHooks: async () => done.push('h') });
    assert.deepEqual(r, { undone: 1, failed: 0, left: 1 }, 'browser steps wait when there is no browser');
    assert.deepEqual(l.summary().map(x => [x.name, x.status, !!x.toUndo]), [['h', 'undone', false], ['s', 'done', true]]);
  });
});
