// Agent primitives: --json envelopes, snapshot, locate, try-step (one-shot) and a warm session, against the fixture app.
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

/** Runs the CLI with --json; stdout must be exactly one JSON document. */
function aft(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args, '--json'], { cwd: root,
      env: { ...process.env, AFT_OUT_DIR: path.join(os.tmpdir(), 'aft-test-out'), MSYS_NO_PATHCONV: '1', ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => {
      let doc = null;
      try { doc = JSON.parse(out); } catch { /* asserted below */ }
      resolve({ code, doc, out, err });
    });
  });
}

const parsed = r => { assert.ok(r.doc, `stdout is not one JSON document:\n${r.out}\n--- stderr:\n${r.err}`); assert.equal(r.doc.schema, 'aft-cli/1'); return r.doc; };

describe('agent primitives', { concurrency: 3, timeout: 600000 }, () => {
  test('--json: a passing run and a failing run, data on stdout, logs on stderr, exit code in the envelope', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-json-'));
    const file = path.join(dir, 'tour.json');
    const tour = steps => fs.writeFileSync(file, JSON.stringify({ name: 'j', baseUrl: app.url, timeouts: { action: 2000, verify: 2000 }, retries: 0,
      scenes: [{ title: 'S', narration: 'Testing.', url: '/ok', steps }] }));
    tour([{ fill: 'Name', text: 'Ann' }]);
    const ok = await aft(['validate', file]);
    const d = parsed(ok);
    assert.equal(ok.code, 0);
    assert.deepEqual([d.ok, d.command, d.class, d.exitCode], [true, 'validate', 'ok', 0]);
    assert.ok(fs.existsSync(d.runDir));
    assert.equal(d.data.blocking, 0);
    assert.match(ok.err, /run folder/, 'logs go to stderr');
    tour([{ fill: 'Nmae', text: 'Ann' }]);
    const bad = await aft(['run', file, '--speech', 'silent']);
    const b = parsed(bad);
    assert.equal(bad.code, 2);
    assert.deepEqual([b.ok, b.class, b.exitCode], [false, 'script', 2]);
    assert.ok(fs.existsSync(b.report), 'report.json path');
    assert.match(b.error.message, /Target not found/);
  });

  test('snapshot, locate and try-step without a session (one-shot browser)', async () => {
    const [snap, loc, miss, step, fail] = await Promise.all([
      aft(['snapshot', '--base-url', app.url, '--url', '/ok']),
      aft(['locate', 'Name', '--base-url', app.url, '--url', '/ok']),
      aft(['locate', 'Nmae', '--base-url', app.url, '--url', '/ok']),
      aft(['try-step', '[{"fill":"Name","text":"Bo"},{"click":"Save"},{"verify":{"text":"Saved Bo"}}]', '--base-url', app.url, '--url', '/ok']),
      aft(['try-step', '{"click":"Svae","timeout":1000}', '--base-url', app.url, '--url', '/ok']),
    ]);
    const s = parsed(snap).data;
    assert.equal(s.schema, 'aft-snapshot/1');
    assert.match(s.url, /\/ok$/);
    assert.match(s.aria, /textbox "Name"/);
    assert.match(s.text, /Fixture/);
    const l = parsed(loc).data;
    assert.equal(l.schema, 'aft-locate/1');
    assert.equal(l.resolved, true);
    assert.equal(l.matches[0].tag, 'input');
    assert.ok(l.strategies.length > 3, 'every strategy tried is listed');
    const m = parsed(miss).data;
    assert.equal(m.resolved, false);
    assert.ok(m.alternatives.includes('Name'), JSON.stringify(m.alternatives));
    const t = parsed(step).data;
    assert.equal(t.schema, 'aft-try-step/1');
    assert.equal(t.ok, true);
    assert.deepEqual(t.steps.map(x => x.ok), [true, true, true]);
    assert.match(t.after.aria, /Saved Bo/);
    assert.equal(fail.code, 2);
    const f = parsed(fail);
    assert.equal(f.class, 'script');
    assert.equal(f.data.steps[0].ok, false);
    assert.ok(f.data.steps[0].suggestions.includes('Save'));
  });

  test('a call the CLI stops waiting for keeps running; aft session wait returns its result', async () => {
    const name = `test-wait-${process.pid}-${Date.now()}`;
    const start = parsed(await aft(['session', 'start', '--base-url', app.url, '--session', name]));
    assert.equal(start.ok, true, JSON.stringify(start));
    try {
      const slow = '[{"goto":"/ok"},{"wait":10},{"fill":"Name","text":"Di"},{"click":"Save"},{"verify":{"text":"Saved Di"}}]';
      const gaveUp = parsed(await aft(['try-step', slow, '--session', name], { AFT_CALL_TIMEOUT: '1' }));
      assert.equal(gaveUp.ok, false);
      assert.equal(gaveUp.exitCode, 1);
      const id = gaveUp.data.callId;
      assert.match(id, /^c-[0-9a-f]+$/);
      assert.equal(gaveUp.data.running, true);
      assert.match(gaveUp.data.hint, new RegExp(`aft session wait ${id} --session ${name}`));
      // Busy while it runs: refused, naming the call.
      const busy = parsed(await aft(['snapshot', '--session', name]));
      assert.equal(busy.ok, false);
      assert.match(busy.error.message, new RegExp(`busy.*${id}`));
      // A short --timeout while it still runs: not done yet.
      const early = parsed(await aft(['session', 'wait', '--session', name, '--timeout', '0']));
      assert.equal(early.ok, false);
      assert.equal(early.data.callId, id);
      const done = parsed(await aft(['session', 'wait', id, '--session', name]));
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(done.data.schema, 'aft-try-step/1');
      assert.equal(done.data.callId, id);
      assert.match(done.data.after.aria, /Saved Di/);
      // Kept after it finished: without an id, the last call; a failing call keeps its class and exit code.
      const again = parsed(await aft(['session', 'wait', '--session', name]));
      assert.equal(again.data.callId, id);
      const failing = parsed(await aft(['try-step', '{"click":"Svae","timeout":500}', '--session', name]));
      assert.equal(failing.exitCode, 2);
      const failed = await aft(['session', 'wait', failing.data.callId, '--session', name]);
      assert.equal(failed.code, 2);
      assert.equal(parsed(failed).class, 'script');
      const unknown = parsed(await aft(['session', 'wait', 'c-nope', '--session', name]));
      assert.equal(unknown.exitCode, 1);
      assert.match(unknown.error.message, /no call c-nope/);
    } finally {
      parsed(await aft(['session', 'stop', '--session', name]));
    }
  });

  test('a session keeps one signed-in browser across calls; stop removes it', async () => {
    const name = `test-${process.pid}-${Date.now()}`;
    const start = parsed(await aft(['session', 'start', '--base-url', app.url, '--session', name]));
    assert.equal(start.ok, true, JSON.stringify(start));
    assert.equal(start.data.status, 'ready');
    assert.ok(!('token' in start.data), 'the control token is never printed');
    try {
      const status = parsed(await aft(['session', 'status', '--session', name]));
      assert.equal(status.data.sessions[0].status, 'ready');
      const a = parsed(await aft(['try-step', '[{"goto":"/ok"},{"fill":"Name","text":"Cy"}]', '--session', name]));
      assert.equal(a.ok, true, JSON.stringify(a));
      // Same page, same state: the field still holds what the previous call typed.
      const b = parsed(await aft(['try-step', '[{"click":"Save"},{"verify":{"text":"Saved Cy"}}]', '--session', name]));
      assert.equal(b.ok, true, JSON.stringify(b));
      const snap = parsed(await aft(['snapshot', '--session', name]));
      assert.match(snap.data.aria, /Saved Cy/);
    } finally {
      const stop = parsed(await aft(['session', 'stop', '--session', name]));
      assert.equal(stop.data.stopped[0].name, name);
    }
    assert.ok(!fs.existsSync(path.join(root, '.sessions', `${name}.json`)));
    const none = parsed(await aft(['session', 'status', '--session', name]));
    assert.deepEqual(none.data.sessions, []);
  });
});
