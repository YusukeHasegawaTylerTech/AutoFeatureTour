// Call ids on a daemon's control port (src/daemon-calls.mjs): results kept for `aft session wait`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallTracker } from '../src/daemon-calls.mjs';

test('wait: the running call, then its stored result; only the last few are kept', async () => {
  const c = new CallTracker({ keep: 2 });
  assert.equal((await c.wait())[0], 404);
  const a = c.begin('try-step', 'c-a');
  assert.equal(c.current, 'c-a');
  const [, pending] = await c.wait(undefined, 10);
  assert.deepEqual([pending.callId, pending.done], ['c-a', false]);
  const waiting = c.wait('c-a', 5000);
  c.finish(a.callId, 200, { ok: true });
  const [code, rec] = await waiting;
  assert.deepEqual([code, rec.done, rec.code, rec.body.ok, 'waiters' in rec], [200, true, 200, true, false]);
  assert.equal(c.current, null);
  assert.equal((await c.wait())[1].callId, 'c-a', 'no id and nothing running: the last finished');
  for (const id of ['c-b', 'c-c']) { c.begin('snapshot', id); c.finish(id, 500, { error: 'x', class: 'error' }); }
  assert.equal((await c.wait('c-a'))[0], 404, 'the oldest is dropped');
  assert.equal((await c.wait('c-c'))[1].code, 500);
  assert.match(c.begin('locate').callId, /^c-[0-9a-f]{8}$/);
});
