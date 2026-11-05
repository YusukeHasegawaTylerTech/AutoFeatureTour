// aft batch: several tours, one reset, each in its own run folder; batch.json / batch.md. Runs the real CLI against the fixture app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childArgs, expandTours } from '../src/batch.mjs';
import { startFixture } from './fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-batch-'));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

// Each reset appends a line to AFT_TEST_STATE/reset.txt.
const RESET = `import fs from 'node:fs'; import path from 'node:path'; fs.mkdirSync(process.env.AFT_TEST_STATE, { recursive: true }); fs.appendFileSync(path.join(process.env.AFT_TEST_STATE, 'reset.txt'), 'reset\\n');`;

function makePlatform(name = 'app', env = {}) {
  const dir = path.join(tmp(), 'platforms');
  const p = path.join(dir, name);
  const hooks = tmp();
  write(path.join(hooks, 'reset.mjs'), RESET);
  write(path.join(p, 'platform.json'), { timeouts: { action: 5000, verify: 5000, navigation: 30000, optional: 1000 }, retries: 0, ignore: ['favicon'] });
  write(path.join(p, 'environments.json'), { default: 'local', local: { baseUrl: app.url + '/', reset: [{ node: path.join(hooks, 'reset.mjs') }], ...env } });
  return { dir, p, name };
}
const scene = steps => [{ title: 'S', narration: 'Testing.', url: '/ok', steps }];
const tour = (platform, name, steps = [{ verify: { role: 'heading', name: 'Fixture' } }]) => {
  const file = path.join(platform.p, 'tours', `${name}.tour.json`);
  write(file, { name, platform: platform.name, scenes: scene(steps) });
  return file;
};

function cli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args], { windowsHide: true, cwd: root, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => resolve({ code, log: out + err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
  });
}

describe('batch helpers', () => {
  test('folders expand to their *.tour.json, sorted; duplicates dropped; flags passed on', () => {
    const d = tmp();
    write(path.join(d, 'b.tour.json'), '{}'); write(path.join(d, 'a.tour.json'), '{}'); write(path.join(d, 'x.json'), '{}');
    assert.deepEqual(expandTours([d, path.join(d, 'a.tour.json')]).map(f => path.basename(f)), ['a.tour.json', 'b.tour.json']);
    assert.throws(() => expandTours([path.join(d, 'nope.tour.json')]), /No such tour file/);
    assert.deepEqual(childArgs({ _: ['batch'], json: true, reset: true, stopOnFail: true, speech: 'silent', target: 'local', noTrim: true }), ['--speech', 'silent', '--target', 'local', '--no-trim']);
  });
});

describe('aft batch', { concurrency: 1, timeout: 900000 }, () => {
  test('one reset, then every tour in its own run folder; exit = the first failure; batch.json and batch.md', async () => {
    const platform = makePlatform();
    const ok1 = tour(platform, 'one'), bad = tour(platform, 'two', [{ click: 'No such thing' }]), ok3 = tour(platform, 'three');
    const out = tmp(), state = tmp();
    const r = await cli(['batch', ok1, bad, ok3, '--reset', '--validate-only', '--json'], { AFT_OUT_DIR: out, AFT_TEST_STATE: state });
    assert.equal(r.code, 2, r.log);
    assert.equal(r.json.class, 'script');
    assert.equal(fs.readFileSync(path.join(state, 'reset.txt'), 'utf8'), 'reset\n', 'the reset ran once');
    const doc = readJson(path.join(r.json.runDir, 'batch.json'));
    assert.equal(doc.schema, 'aft-batch/1');
    assert.equal(path.basename(path.dirname(r.json.runDir)), 'batch');
    assert.deepEqual(doc.tours.map(t => [t.name, t.status, t.exitCode]), [['one', 'passed', 0], ['two', 'failed', 2], ['three', 'passed', 0]]);
    assert.equal(new Set(doc.tours.map(t => t.runDir)).size, 3);
    for (const t of doc.tours) assert.ok(fs.existsSync(path.join(t.runDir, 'run.json')));
    assert.ok(doc.tours[0].verdict);
    assert.match(fs.readFileSync(path.join(r.json.runDir, 'batch.md'), 'utf8'), /\| 2 \| two \| failed \| 2 \| script/);
  });

  test('--stop-on-fail skips the rest; tours on different platforms refuse --reset (exit 1)', async () => {
    const a = makePlatform('app'), b = makePlatform('other');
    const bad = tour(a, 'bad', [{ click: 'No such thing' }]), next = tour(a, 'next');
    const [stop, mixed] = await Promise.all([
      cli(['batch', bad, next, '--validate-only', '--stop-on-fail', '--json'], { AFT_OUT_DIR: tmp(), AFT_TEST_STATE: tmp() }),
      cli(['batch', tour(a, 'x'), tour(b, 'y'), '--reset', '--validate-only', '--json'], { AFT_OUT_DIR: tmp(), AFT_TEST_STATE: tmp() }),
    ]);
    assert.equal(stop.code, 2, stop.log);
    assert.deepEqual(stop.json.data.tours.map(t => t.status), ['failed', 'skipped']);
    assert.equal(mixed.code, 1, mixed.log);
    assert.match(mixed.json.error.message, /one platform and environment/);
  });

  test('a shared environment refuses --reset as aft reset does', async () => {
    const platform = makePlatform('app', { shared: true });
    const r = await cli(['batch', tour(platform, 's'), '--reset', '--validate-only', '--json'], { AFT_OUT_DIR: tmp(), AFT_TEST_STATE: tmp() });
    assert.equal(r.code, 1, r.log);
    assert.match(r.json.error.message, /is shared: it is never reset/);
  });
});
