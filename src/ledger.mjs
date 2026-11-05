// Repeatable runs: what a run set up, and what is still to be undone.
//
// <run>/ledger.json (schema aft-ledger/1) lists every fixture item, browser cleanup and pinned artifact of a run, each
// written *before* it runs, so a killed process still leaves a record:
//
//   pending → done → undone | undo-failed      (or: in-place: its check held, nothing set up and nothing to undo;
//                                                failed: its setup failed, so it isn't undone)
//
// An item's "undo" is hooks ({ "hooks": [...] }, run without a browser) or browser steps ({ "steps": [...] }, run in
// the run's browser, or in a one-shot signed-in session by `aft cleanup`). Items are undone in reverse, and only the
// ones that ran. `aft cleanup` finds ledgers with undo steps still pending (a crash, Ctrl+C, a failed teardown) and
// runs them; the start of a run does the same for earlier runs of the same tour, so a rerun after a crash is safe.

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_LEDGER = 'aft-ledger/1';
const OPEN = new Set(['pending', 'done']);

/** The run tag for a run folder (…/20261105-143012-kczy → aft-1105-kczy): unique per run, usable in test data. */
export function runTag(outDir) {
  const m = path.basename(String(outDir ?? '')).match(/^\d{4}(\d{4})-\d{6}-([a-z0-9]+)$/i);
  return m ? `aft-${m[1]}-${m[2]}` : `aft-${Date.now().toString(36)}`;
}

export class Ledger {
  constructor(file, meta = {}) {
    this.file = file;
    this.doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: SCHEMA_LEDGER, ...meta, startedAt: new Date().toISOString(), items: [] };
  }

  static read(file) { return new Ledger(file); }

  get items() { return this.doc.items; }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.doc, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Records an item before it runs (status pending) and returns it; set() moves it on. */
  add(item) {
    const it = { id: `${this.doc.items.length + 1}`, status: 'pending', at: new Date().toISOString(), ...item };
    this.doc.items.push(it);
    this.save();
    return it;
  }

  set(item, status, extra = {}) {
    Object.assign(item, { status, ...extra, [`${status}At`]: new Date().toISOString() });
    this.save();
    return item;
  }

  /** Items whose undo hasn't run yet, newest first. */
  pending({ retryFailed = false } = {}) { return this.doc.items.filter(i => i.undo && (OPEN.has(i.status) || (retryFailed && i.status === 'undo-failed'))).reverse(); }

  /** What report.json "fixtures" shows: each item and what happened to it. */
  summary() {
    return this.doc.items.map(({ id, name, kind, fixture, status, error, artifact, undoError, undo }) => ({ id, name, kind, ...(fixture ? { fixture } : {}), ...(artifact ? { artifact } : {}),
      status, ...(undo && OPEN.has(status) ? { toUndo: true } : {}), ...(error ? { error } : {}), ...(undoError ? { undoError } : {}) }));
  }
}

/**
 * Undoes the ledger's open items, newest first. undoHooks(hooks) and undoSteps(steps) do the work; a missing one (no
 * browser any more) leaves those items open for `aft cleanup`. kinds: only items of these undo kinds.
 * Returns { undone, failed, left }.
 */
export async function undoAll(ledger, { undoHooks, undoSteps, log = () => {}, deadline, retryFailed = false } = {}) {
  const out = { undone: 0, failed: 0, left: 0 };
  for (const item of ledger.pending({ retryFailed })) {
    const fn = item.undo.steps ? undoSteps : undoHooks;
    if (!fn || (deadline && Date.now() > deadline)) { out.left++; continue; }
    try {
      log(`undo: ${item.name}`);
      await fn(item.undo.steps ?? item.undo.hooks, item);
      ledger.set(item, 'undone');
      out.undone++;
    } catch (e) {
      const msg = e.message.split('\n')[0];
      log(`undo failed: ${item.name}: ${msg}`);
      ledger.set(item, 'undo-failed', { undoError: msg });
      out.failed++;
    }
  }
  return out;
}

/** Ledgers under an out folder (out/<name>/<run>/ledger.json) that still have something to undo. */
export function openLedgers(outRoot, { name, platform, env, tag, olderThanMs, includeFailed = true } = {}) {
  const found = [];
  if (!fs.existsSync(outRoot)) return found;
  const names = name ? [name] : fs.readdirSync(outRoot).filter(n => !n.startsWith('.'));
  for (const n of names) {
    const base = path.join(outRoot, n);
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
    for (const r of fs.readdirSync(base)) {
      const file = path.join(base, r, 'ledger.json');
      if (!fs.existsSync(file)) continue;
      let l;
      try { l = Ledger.read(file); } catch { continue; }
      const d = l.doc;
      if (platform && d.platform !== platform) continue;
      if (env && d.env !== env) continue;
      if (tag && !String(d.tag ?? '').startsWith(tag)) continue;
      if (olderThanMs && Date.now() - Date.parse(d.startedAt ?? 0) < olderThanMs) continue;
      const open = l.pending({ retryFailed: includeFailed }).length;
      if (open) found.push({ dir: path.join(base, r), file, ledger: l });
    }
  }
  return found;
}

/** "2d", "12h", "30m" → milliseconds. */
export function parseAge(s) {
  const m = String(s ?? '').match(/^(\d+(?:\.\d+)?)\s*([smhd])$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
}
