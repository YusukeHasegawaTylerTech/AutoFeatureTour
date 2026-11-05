// Call ids for the control port of a session or stage daemon (src/session-daemon.mjs, src/stage-daemon.mjs).
// Every queued call (snapshot, locate, try-step, …) carries an id (the CLI makes one, else the daemon does). A call
// keeps running when the caller's HTTP wait gives up; its result is kept (the last few) so `aft session wait` can
// fetch it later, while it runs or after it finished.

import crypto from 'node:crypto';

export const newCallId = () => `c-${crypto.randomBytes(4).toString('hex')}`;

export class CallTracker {
  constructor({ keep = 10 } = {}) { this.keep = keep; this.calls = new Map(); this.current = null; }

  /** Registers a call; returns its record. */
  begin(op, id) {
    const rec = { callId: id || newCallId(), op, startedAt: new Date().toISOString(), done: false, waiters: [] };
    this.calls.set(rec.callId, rec);
    this.current = rec.callId;
    return rec;
  }

  /** Stores the HTTP code and body a call answered with, and wakes anyone waiting for it. */
  finish(id, code, body) {
    const rec = this.calls.get(id);
    if (!rec || rec.done) return;
    Object.assign(rec, { done: true, code, body, finishedAt: new Date().toISOString() });
    if (this.current === id) this.current = null;
    for (const w of rec.waiters.splice(0)) w();
    const finished = [...this.calls.values()].filter(r => r.done);
    for (const r of finished.slice(0, Math.max(0, finished.length - this.keep))) this.calls.delete(r.callId);
  }

  /** The call to wait for: the named one, else the running one, else the last finished one. */
  pick(id) {
    if (id) return this.calls.get(id) ?? null;
    if (this.current) return this.calls.get(this.current);
    return [...this.calls.values()].filter(r => r.done).at(-1) ?? null;
  }

  view(rec) {
    const { waiters, ...v } = rec;
    return v;
  }

  /** Waits up to ms for the call; answers [httpCode, body] for the daemon's `wait` op. */
  async wait(id, ms = 60000) {
    const rec = this.pick(id);
    if (!rec) return [404, { error: id ? `no call ${id} here (known: ${[...this.calls.keys()].join(', ') || 'none'}; only the last ${this.keep} finished calls are kept)` : 'no call has run here yet', class: 'error' }];
    if (!rec.done) {
      await new Promise(r => { const t = setTimeout(r, Math.max(0, ms)); rec.waiters.push(() => { clearTimeout(t); r(); }); });
    }
    return [200, this.view(rec)];
  }
}
