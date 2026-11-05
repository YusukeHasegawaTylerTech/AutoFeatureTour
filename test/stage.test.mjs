// Staging ("do / redo until here"): stop points, deferred undo, end (undo in reverse or keep), redo. Runs the real CLI
// against the fixture app; stages are detached processes, headless here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rangeFor, stagePoint } from '../src/stage.mjs';
import { startFixture } from './fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-stage-'));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

const ITEM = `import fs from 'node:fs'; import path from 'node:path';
const [op, name] = process.argv.slice(2); const dir = process.env.AFT_TEST_STATE; fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'log.txt'), op + ' ' + name + ' ' + (process.env.RUN_TAG ?? '') + '\\n');
`;
const hook = (op, name) => ({ node: 'item.mjs', args: [op, name] });

let app;
const started = [];
before(async () => { app = await startFixture(); });
after(async () => {
  for (const s of started) await cli(['stage', 'end', s]).catch(() => {});
  app?.close();
});

function cli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args], { cwd: root, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => resolve({ code, out, err, log: out + err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
  });
}

function setup(scenes) {
  const dir = path.join(tmp(), 'platforms');
  const p = path.join(dir, 'app');
  write(path.join(p, 'platform.json'), { timeouts: { action: 5000, verify: 5000, navigation: 30000, optional: 1000 }, retries: 0, ignore: ['favicon'] });
  write(path.join(p, 'environments.json'), { default: 'local', local: { baseUrl: app.url + '/' } });
  write(path.join(p, 'fixtures', 'item.mjs'), ITEM);
  write(path.join(p, 'fixtures', 'data.json'), { items: [
    { name: 'a', setup: hook('create', 'a'), teardown: hook('delete', 'a') },
    { name: 'b', setup: hook('create', 'b'), teardown: hook('delete', 'b') },
  ] });
  const name = `st-${Math.random().toString(36).slice(2, 7)}`;
  const file = path.join(p, 'tours', `${name}.tour.json`);
  write(file, { name, platform: 'app', fixtures: ['data'], scenes });
  const env = { AFT_OUT_DIR: tmp(), AFT_TEST_STATE: tmp() };
  const statelog = () => { const f = path.join(env.AFT_TEST_STATE, 'log.txt'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/) : []; };
  const stage = async (...a) => { const r = await cli(['stage', file, '--headless', '--json', ...a], env); if (r.json?.data?.name) started.push(r.json.data.name); return r; };
  return { file, name, env, statelog, stage, end: (...a) => cli(['stage', 'end', `stage-${name}-local`, '--json', ...a], env) };
}

const sceneSteps = report => report.steps.filter(x => !/(url)/.test(x.scene));
const heading = { verify: { role: 'heading', name: 'Fixture' } };
const two = [{ title: 'One', narration: 'One.', url: '/ok', steps: [heading, heading] }, { title: 'Two', narration: 'Two.', url: '/ok', steps: [heading] }];

describe('stage points', () => {
  test('flags → range', () => {
    assert.deepEqual(stagePoint({}), {});
    assert.deepEqual(stagePoint({ untilScene: '2' }), { untilScene: 2 });
    assert.deepEqual(stagePoint({ setupOnly: true }), { setupOnly: true });
    assert.throws(() => stagePoint({ untilScene: 1, untilStep: 2 }), /one of/);
    assert.throws(() => stagePoint({ untilStep: '0' }), /number from 1/);
    assert.equal(rangeFor({ setupOnly: true }).scenes, 0);
    assert.equal(rangeFor({ untilScene: 1 }).scenes, 1);
    assert.equal(rangeFor({ untilStep: 3 }).until, 3);
    assert.deepEqual(stagePoint({ untilScene: '2', step: '3' }), { untilScene: 2, step: 3 });
    assert.throws(() => stagePoint({ step: 1 }), /goes with --until-scene/);
    assert.equal(rangeFor({ untilScene: 2, step: 3 }).step, 3);
    assert.equal(rangeFor({}), null);
  });
});

describe('aft stage', { concurrency: 1, timeout: 600000 }, () => {
  test('until scene 1: data set up and kept live; try-step works on it; end undoes in reverse', async () => {
    const s = setup(two);
    const r = await s.stage('--until-scene', '1');
    assert.equal(r.code, 0, r.log);
    const d = r.json.data;
    assert.equal(d.state, 'staged');
    assert.match(d.reached, /stopped after scene 1/);
    assert.match(d.url, /\/ok$/);
    assert.ok(!('token' in d) && !('port' in d), 'no control token in the output');
    const ledger = readJson(path.join(r.json.runDir, 'ledger.json'));
    assert.deepEqual(ledger.items.map(i => i.status), ['done', 'done'], 'undo deferred');
    assert.equal(ledger.stage.live, true);
    assert.equal(readJson(path.join(r.json.runDir, 'run.json')).status, 'staged');
    const report = readJson(path.join(r.json.runDir, 'report.json'));
    assert.deepEqual(sceneSteps(report).map(x => x.scene), ['scene-01', 'scene-01'], 'scene 2 did not run');
    assert.ok(fs.existsSync(path.join(r.json.runDir, 'screens', 'stage.png')));

    const list = await cli(['stage', 'list', '--json'], s.env);
    assert.ok(list.json.data.stages.some(x => x.name === d.name && x.state === 'staged'), list.log);
    const tried = await cli(['try-step', JSON.stringify(heading), '--session', d.name, '--json'], s.env);
    assert.equal(tried.code, 0, tried.log);

    const again = await s.stage('--until-scene', '1');
    assert.equal(again.code, 1, 'one stage per tour + env');
    assert.match(again.json.error.message, /already staged.*--redo/);

    const e = await s.end();
    assert.equal(e.code, 0, e.log);
    assert.deepEqual(s.statelog().map(l => l.split(' ').slice(0, 2).join(' ')), ['create a', 'create b', 'delete b', 'delete a']);
    const after = readJson(path.join(r.json.runDir, 'ledger.json'));
    assert.deepEqual(after.items.map(i => i.status), ['undone', 'undone']);
    assert.equal(after.stage.live, false);
    assert.equal(readJson(path.join(r.json.runDir, 'run.json')).status, 'ended');
    assert.ok(!fs.existsSync(path.join(root, '.sessions', `${d.name}.json`)));
  });

  test('setup only, end --keep: the ledger stays pending; a later run of the tour leaves it alone', async () => {
    const s = setup(two);
    const r = await s.stage('--setup-only');
    assert.equal(r.code, 0, r.log);
    assert.match(r.json.data.reached, /stopped after setup/);
    assert.equal(sceneSteps(readJson(path.join(r.json.runDir, 'report.json'))).length, 0);
    const e = await s.end('--keep');
    assert.equal(e.code, 0, e.log);
    const ledger = readJson(path.join(r.json.runDir, 'ledger.json'));
    assert.deepEqual(ledger.items.map(i => i.status), ['done', 'done']);
    assert.equal(ledger.stage.kept, true);
    const v = await cli(['validate', s.file, '--json'], s.env);
    assert.equal(v.code, 0, v.log);
    assert.doesNotMatch(v.log, /earlier run\(s\) of this tour left data behind/);
    assert.deepEqual(readJson(path.join(r.json.runDir, 'ledger.json')).items.map(i => i.status), ['done', 'done']);
  });

  test('--redo undoes the current stage, then stages again with a new tag; until-step stops mid-scene', async () => {
    const s = setup(two);
    const first = await s.stage('--until-step', '1');
    assert.equal(first.code, 0, first.log);
    assert.equal(sceneSteps(readJson(path.join(first.json.runDir, 'report.json'))).length, 1);
    const redo = await s.stage('--until-scene', '1', '--step', '1', '--redo');
    assert.equal(redo.code, 0, redo.log);
    assert.notEqual(redo.json.runDir, first.json.runDir);
    assert.match(redo.json.data.reached, /stopped after scene 1 · step 1/);
    assert.equal(sceneSteps(readJson(path.join(redo.json.runDir, 'report.json'))).length, 1);
    assert.deepEqual(readJson(path.join(first.json.runDir, 'ledger.json')).items.map(i => i.status), ['undone', 'undone']);
    assert.notEqual(redo.json.data.tag, first.json.data.tag);
    const ops = s.statelog().map(l => l.split(' ').slice(0, 2).join(' '));
    assert.deepEqual(ops, ['create a', 'create b', 'delete b', 'delete a', 'create a', 'create b']);
    assert.equal(redo.json.data.replaced.undo.undone, 2);
    await s.end();
  });

  test('a failing check fails the stage (CRITERION) but keeps the browser and the data until it ends', async () => {
    const s = setup([{ title: 'Bad', narration: 'Bad.', url: '/ok', steps: [{ verify: { role: 'heading', name: 'Nope' } }] }]);
    const r = await s.stage();
    assert.equal(r.code, 4, r.log);
    assert.equal(r.json.data.state, 'failed');
    assert.equal(r.json.data.class, 'criterion');
    assert.equal(readJson(path.join(r.json.runDir, 'run.json')).status, 'failed');
    const list = await cli(['stage', 'list', '--json'], s.env);
    assert.ok(list.json.data.stages.some(x => x.name === r.json.data.name && x.alive), 'still live at the failure');
    const e = await s.end();
    assert.equal(e.code, 0, e.log);
    assert.deepEqual(readJson(path.join(r.json.runDir, 'ledger.json')).items.map(i => i.status), ['undone', 'undone']);
  });
});
