// The UI server (ui/server.mjs) as a black box: a throwaway checkout (--root) with one platform and one run, the
// server on a free port, and plain HTTP. Covers the token, path limits, write-only secrets, the trash (delete and
// restore), the ledger summary, {data.x} values and the schema endpoint.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const TOKEN = 'ab12cd34ef56ab12cd34ef56ab12cd34';
const RUN = 'demo-tour/20261105-120000-abcd';

let root, server, base;
const req = (p, { method = 'GET', body, cookie = true, raw = false } = {}) => fetch(base + p, {
  method, redirect: 'manual',
  headers: { ...(cookie ? { cookie: `aft_ui=${TOKEN}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => (raw ? r : { status: r.status, json: await r.json().catch(() => null) }));

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-ui-'));
  fs.cpSync(path.join(repo, 'schemas'), path.join(root, 'schemas'), { recursive: true });
  const pd = path.join(root, 'platforms', 'demo');
  write(path.join(pd, 'platform.json'), { data: { greeting: 'hello', password: 'pw-plain-1' } });
  write(path.join(pd, 'environments.json'), { default: 'local', local: { baseUrl: 'http://localhost:1/app/', data: { greeting: 'hi from local', user: '{env:DEMO_USER}' } } });
  write(path.join(pd, 'login.json'), { default: 'user', roles: { user: { steps: [{ fill: 'User', text: '{env:DEMO_USER}' }, { fill: 'Password', text: '{env:DEMO_PASS}', secret: true }] } } });
  write(path.join(pd, 'fixtures', 'fx.json'), { data: { task: 'Buy milk' } });
  write(path.join(pd, 'tours', 'a.tour.json'), { name: 'a', platform: 'demo', fixtures: ['fx'], scenes: [{ title: 'One', narration: 'Hi', steps: [] }] });
  write(path.join(root, '.env'), 'OTHER=1\n');
  const rd = path.join(root, 'out', ...RUN.split('/'));
  write(path.join(rd, 'run.json'), { name: 'demo-tour', command: 'run', status: 'failed', startedAt: '2026-11-05T12:00:00Z', input: ['platforms/demo/tours/a.tour.json'] });
  write(path.join(rd, 'ledger.json'), { schema: 'aft-ledger/1', platform: 'demo', env: 'local', tag: 'aft-1105-abcd', items: [
    { id: 1, name: 'account', kind: 'hooks', status: 'done', undo: { hooks: [{ run: 'delete-account --password pw-in-undo-9' }] } },
    { id: 2, name: 'seed', kind: 'hooks', status: 'undone', undo: { hooks: [{ run: 'x' }] } }] });

  server = spawn(process.execPath, [path.join(repo, 'ui', 'server.mjs'), '--root', root, '--port', '0', '--no-open'],
    { env: Object.fromEntries(Object.entries({ ...process.env, AFT_UI_TOKEN: TOKEN }).filter(([k]) => !k.startsWith('DEMO_'))), stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((ok, bad) => {
    let out = '';
    server.stdout.on('data', c => { out += c; const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out); if (m) ok(`http://127.0.0.1:${m[1]}`); });
    server.on('exit', code => bad(new Error(`server exited ${code}`)));
    setTimeout(() => bad(new Error('server did not start')), 10000);
  });
});
after(() => { server?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

describe('ui server', () => {
  test('every call needs the token; the token URL sets the cookie', async () => {
    assert.equal((await req('/api/platforms', { cookie: false })).status, 401);
    const r = await req(`/?token=${TOKEN}`, { cookie: false, raw: true });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('set-cookie'), new RegExp(`aft_ui=${TOKEN}; HttpOnly; SameSite=Strict`));
    assert.equal((await req('/api/platforms')).status, 200);
  });

  test('platform files: only definition files under platforms/<name>/', async () => {
    assert.equal((await req('/api/pfile?path=platforms/demo/platform.json')).status, 200);
    for (const bad of ['.env', 'platforms/../.env', 'platforms/demo/../../.env', 'auth/demo/local/user.json', 'platforms/demo/.env',
      'platforms/demo/node_modules/x.json', 'platforms/platform.json', 'src/cli.mjs', 'platforms/demo/x.exe'])
      assert.equal((await req(`/api/pfile?path=${encodeURIComponent(bad)}`)).status, 403, bad);
    const put = await req('/api/pfile?path=platforms/demo/fixtures/new.json', { method: 'PUT', body: { text: '{ not json' } });
    assert.equal(put.status, 400);
    assert.equal((await req('/api/pfile?path=platforms/demo/tours/a.tour.json', { method: 'PUT', body: { text: '{}', create: true } })).status, 409);
  });

  test('run files never leave out/', async () => {
    const r = await req(`/api/file/${encodeURIComponent('..')}/${encodeURIComponent('.env')}`);
    assert.notEqual(r.status, 200);
    assert.equal((await req(`/api/file/${RUN}/run.json`)).status, 200);
  });

  test('/api/secret writes only names the platform references, and never returns a value', async () => {
    assert.equal((await req('/api/secret', { method: 'PUT', body: { platform: 'demo', name: 'OTHER', value: 'x' } })).status, 403);
    assert.equal((await req('/api/secret', { method: 'PUT', body: { platform: 'demo', name: 'DEMO_PASS', value: 'a\nb' } })).status, 400);
    assert.equal((await req('/api/secret', { method: 'PUT', body: { platform: 'demo', name: 'DEMO_PASS', value: 's3cret-value' } })).status, 200);
    assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /^OTHER=1\nDEMO_PASS=s3cret-value\n$/);
    const d = await req('/api/platform?name=demo');
    assert.deepEqual(d.json.env.find(e => e.name === 'DEMO_PASS'), { name: 'DEMO_PASS', source: '.env' });
    assert.equal(JSON.stringify(d.json).includes('s3cret-value'), false);
  });

  test('ledger summary: outcomes only, never the undo steps; pending undo counts as left behind', async () => {
    const d = await req(`/api/run?id=${RUN}`);
    assert.deepEqual(d.json.ledger.items.map(i => [i.name, i.status, i.undo]), [['account', 'done', 'hooks'], ['seed', 'undone', 'hooks']]);
    assert.equal(JSON.stringify(d.json).includes('pw-in-undo-9'), false);
    const p = await req('/api/platform?name=demo');
    assert.equal(p.json.cleanup.items, 1);
    assert.equal(p.json.cleanup.runs[0].id, RUN);
  });

  test('{data.x} values: platform < environment < fixtures; credential-like keys masked', async () => {
    const d = (await req('/api/tour-data?path=platforms/demo/tours/a.tour.json')).json;
    assert.deepEqual(d.data.greeting, { value: 'hi from local', source: 'environment local' });
    assert.deepEqual(d.data.task, { value: 'Buy milk', source: 'fixture fx' });
    assert.deepEqual(d.data.user, { value: '{env:DEMO_USER}', source: 'environment local' });
    assert.equal(d.data.password.value, '●●●');
    assert.equal((await req('/api/tour-data?path=out/x/tour.json')).status, 403);
  });

  test('schema endpoint serves the definition schemas', async () => {
    const r = await req('/api/schema?type=environments');
    assert.equal(r.status, 200);
    assert.match(r.json.schema.$id, /environments\.schema\.json$/);
    assert.ok(r.json.common.$defs);
    assert.equal((await req('/api/schema?type=../x')).status, 400);
  });

  test('delete moves to the trash; restore puts it back, unless its place is taken', async () => {
    const tour = 'platforms/demo/tours/a.tour.json';
    const del = await req('/api/delete', { method: 'POST', body: { kind: 'file', path: tour } });
    assert.equal(del.status, 200);
    assert.equal(fs.existsSync(path.join(root, tour)), false);
    let trash = (await req('/api/trash')).json;
    assert.deepEqual(trash.map(i => [i.path, i.kind, i.exists]), [[tour, 'file', false]]);
    assert.ok(trash[0].deletedAt);

    // its place taken: refused
    write(path.join(root, tour), { name: 'a', platform: 'demo', scenes: [] });
    assert.equal((await req('/api/trash')).json[0].exists, true);
    assert.equal((await req('/api/restore', { method: 'POST', body: { id: trash[0].id } })).status, 409);
    fs.rmSync(path.join(root, tour));

    const r = await req('/api/restore', { method: 'POST', body: { id: trash[0].id } });
    assert.deepEqual(r.json, { restored: tour });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, tour), 'utf8')).fixtures[0], 'fx');
    assert.deepEqual((await req('/api/trash')).json, []);
    assert.equal((await req('/api/restore', { method: 'POST', body: { id: trash[0].id } })).status, 404);

    // a whole run and a whole platform
    assert.equal((await req('/api/delete', { method: 'POST', body: { kind: 'run', path: RUN } })).status, 200);
    trash = (await req('/api/trash')).json;
    assert.deepEqual(trash.map(i => [i.path, i.kind]), [[`out/${RUN}`, 'run']]);
    assert.equal((await req('/api/restore', { method: 'POST', body: { id: trash[0].id } })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'out', ...RUN.split('/'), 'ledger.json')));
    assert.equal((await req('/api/delete', { method: 'POST', body: { kind: 'platform', path: 'demo' } })).status, 200);
    trash = (await req('/api/trash')).json;
    assert.deepEqual(trash.map(i => [i.path, i.kind]), [['platforms/demo', 'platform']]);
    assert.equal((await req('/api/restore', { method: 'POST', body: { id: trash[0].id } })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'platforms', 'demo', 'login.json')));
  });

  test('trash written before item.json existed is still read', async () => {
    const stamp = '2026-11-01T10-00-00-000Z';
    write(path.join(root, 'out', '.trash', stamp, 'platforms', 'demo', 'fragments', 'old.json'), { steps: [] });
    const item = (await req('/api/trash')).json.find(i => i.stamp === stamp);
    assert.deepEqual([item.path, item.kind, item.deletedAt], ['platforms/demo/fragments/old.json', 'file', '2026-11-01T10:00:00.000Z']);
    assert.equal((await req('/api/restore', { method: 'POST', body: { id: stamp } })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'platforms', 'demo', 'fragments', 'old.json')));
  });

  test('jobs: only the allowed commands; import only from uploaded files', async () => {
    assert.equal((await req('/api/jobs', { method: 'POST', body: { args: ['ui'] } })).status, 400);
    assert.equal((await req('/api/jobs', { method: 'POST', body: { args: ['import', path.join(root, '.env'), '--platform', 'demo'] } })).status, 400);
  });
});
