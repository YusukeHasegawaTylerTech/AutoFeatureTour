// Test data for a run: setup/teardown hooks, paired fixture items, browser fixture steps and their cleanup, pinned
// artifacts, and finishing an undo later (`aft cleanup`). Every item goes through the run's ledger (src/ledger.mjs).
//
//   before the browser   fixture items in order: check (already in place? skip) → setup → check again
//   in the browser       earlier crashed runs' browser undo; each fixture's checkSteps (in place? skip) → steps
//   during the scenes    pin steps: artifacts, their cleanup recorded at once
//   after the last scene browser undo (artifacts' and fixtures' cleanupSteps), in a separate page, also on failure
//   after the browser    hook undo (artifact hooks, item teardowns), newest first; only what ran

import fs from 'node:fs';
import path from 'node:path';
import { Failure } from './failures.mjs';
import { Ledger, openLedgers, undoAll } from './ledger.mjs';
import { fillArtifacts, runSteps } from './steps.mjs';
import { run } from './util.mjs';

/**
 * Runs setup/teardown hooks: a shell command, an HTTP call, or a Node script. A hook with "output" looks data up (a
 * record id from a query): its stdout or response becomes data, "json" (an object, merged) or "text" (data.<as>).
 * With "pin" too, what it printed is pinned as an artifact (onPin). Returns the data the hooks produced.
 */
export async function runHooks(hooks = [], { dir: tourDir, outDir, baseUrl, log, tag, onPin }) {
  const env = { ...process.env, BASE_URL: baseUrl, RUN_DIR: outDir, ...(tag ? { RUN_TAG: tag } : {}) };
  const data = {};
  const take = async (h, text) => {
    if (!h.output) return;
    const label = h.run ?? h.node ?? h.http?.url;
    let got;
    if (h.output === 'json') {
      try { got = JSON.parse(text); } catch { throw new Error(`hook ${label}: "output": "json", but it printed no JSON: ${String(text).trim().slice(0, 200)}`); }
      if (!got || typeof got !== 'object' || Array.isArray(got)) throw new Error(`hook ${label}: "output": "json" must print a JSON object`);
    } else {
      if (!h.as) throw new Error(`hook ${label}: "output": "text" needs "as" (the data key)`);
      const v = String(text).trim();
      if (!v) throw new Error(`hook ${label}: printed nothing for data.${h.as}`);
      got = { [h.as]: v };
    }
    Object.assign(data, got);
    log(`hook data: ${Object.keys(data).join(', ')}`);
    if (h.pin) await onPin?.({ name: h.pin, role: h.role ?? null, fields: Object.fromEntries(Object.entries(got).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
      secret: h.secret ?? [], source: 'setup', stepKey: 'setup', at: new Date().toISOString() });
  };
  for (const h of hooks) {
    const dir = h.dir ?? tourDir; // fixture hooks run from the fixture's folder
    try {
      if (h.run) { log(`hook: ${h.run}`); await take(h, await run(h.run, [], { cwd: path.resolve(dir, h.cwd ?? '.'), env, shell: true, capture: !!h.output })); }
      else if (h.node) { log(`hook: node ${h.node}`); await take(h, await run(process.execPath, [path.resolve(dir, h.node), ...(h.args ?? [])], { cwd: dir, env, capture: !!h.output })); }
      else if (h.http) {
        const { method = 'POST', url, headers = {}, body } = h.http;
        log(`hook: ${method} ${url}`);
        const res = await fetch(new URL(url, baseUrl + '/'), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
        const text = await res.text();
        if (!res.ok) throw new Error(`hook ${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
        await take(h, text);
      } else throw new Error(`Unknown hook ${JSON.stringify(h)} (run, node or http)`);
    } catch (e) {
      if (!h.optional) throw e;
      log(`hook failed (optional): ${e.message.split('\n')[0]}`);
    }
  }
  return data;
}

/** {artifact…} filled where it can be (a value pinned later stays a placeholder until then). */
const tryFill = (v, artifacts) => { try { return fillArtifacts(v, artifacts); } catch { return v; } };

/**
 * Fixture items before the browser starts, in order, each in the ledger before it runs. An item whose check holds is
 * "in place" (skipped, nothing to undo). A setup that fails stops the run; what ran before it is undone afterwards.
 * Returns the data the hooks looked up.
 */
export async function setupItems(items = [], { ledger, hookCtx, artifacts, log }) {
  const looked = {};
  const holds = check => runHooks([{ ...check, optional: false, output: undefined }], { ...hookCtx, log: () => {} }).then(() => true, () => false);
  for (const it of items) {
    const undo = it.teardown?.length ? { hooks: it.teardown } : null;
    const base = { name: it.name, kind: 'hook', fixture: it.fixture, ...(it.readOnly ? { readOnly: true } : {}) };
    if (!it.setup?.length) { ledger.add({ ...base, status: 'done', undo }); continue; } // an older-style teardown list
    if (it.check && await holds(it.check)) {
      log(`fixture ${it.name}: already in place`);
      ledger.add({ ...base, status: 'in-place', undo: null });
      continue;
    }
    const rec = ledger.add({ ...base, undo });
    try { Object.assign(looked, await runHooks(it.setup, hookCtx)); } catch (e) {
      ledger.set(rec, 'failed', { error: e.message.split('\n')[0] });
      throw Object.assign(e, { fixtureItem: it.name });
    }
    // Its undo may name what its setup pinned: resolved now, so `aft cleanup` can run it later.
    if (rec.undo) rec.undo = tryFill(rec.undo, artifacts());
    ledger.set(rec, 'done');
    if (it.check && !(await holds(it.check)))
      throw new Failure('script', `SETUP: fixture item "${it.name}": its setup ran, but its check still fails (the setup didn't create what the check looks for)`);
  }
  return looked;
}

/**
 * Each fixture's browser steps, off camera before the first scene. checkSteps all passing means the data is already
 * there: its steps (and their cleanup) are skipped.
 */
export async function setupBrowser(t, groups = [], { ledger, opts, log }) {
  for (const b of groups) {
    if (b.checkSteps?.length) {
      const inPlace = await runSteps(t, b.checkSteps, { ...opts, unpaced: true, scene: `fixtures (${b.fixture} check)`, report: null, onError: 'fail', retries: 0 }).then(() => true, () => false);
      if (inPlace) { log(`fixture ${b.fixture}: already in place (its checkSteps passed)`); ledger.add({ name: `${b.fixture} steps`, kind: 'steps', fixture: b.fixture, status: 'in-place', undo: null }); continue; }
    }
    if (!b.steps?.length && !b.cleanupSteps?.length) continue;
    const rec = ledger.add({ name: `${b.fixture} steps`, kind: 'steps', fixture: b.fixture, undo: b.cleanupSteps?.length ? { steps: b.cleanupSteps } : null, ...(b.readOnly ? { readOnly: true } : {}) });
    try { if (b.steps?.length) await runSteps(t, b.steps, { ...opts, unpaced: true, scene: 'fixtures' }); } catch (e) { ledger.set(rec, 'failed', { error: e.message.split('\n')[0] }); throw e; }
    ledger.set(rec, 'done');
  }
}

/** A pinned artifact's cleanup in the ledger (browser steps or hooks), recorded the moment it is pinned. */
export function recordArtifact(ledger, a) {
  if (!a.cleanup || a.readOnly) return null;
  const list = [a.cleanup].flat();
  const isHooks = list.every(x => x && typeof x === 'object' && ('run' in x || 'node' in x || 'http' in x));
  return ledger.add({ name: `artifact ${a.name}`, kind: 'artifact', artifact: a.name, status: 'done', undo: isHooks ? { hooks: list } : { steps: list } });
}

/**
 * Browser undo (cleanup steps of artifacts and fixtures) in a page of its own, so a failed scene's page stays as it
 * was for the triage bundle; its video is discarded. Hook undo is left for later.
 */
export async function undoInBrowser(t, ledger, { opts, log, deadline }) {
  if (!t.context || !ledger.pending().some(i => i.undo.steps)) return { undone: 0, failed: 0, left: 0 };
  const main = t.page;
  const page = await t.context.newPage();
  t.page = page;
  try {
    return await undoAll(ledger, { undoSteps: steps => runSteps(t, fillArtifacts(steps, t.artifacts ?? []), { ...opts, unpaced: true, scene: 'cleanup', report: null, onError: 'fail' }), log, deadline });
  } finally {
    const v = page.video();
    await page.close().catch(() => {});
    await v?.delete().catch(() => {});
    t.page = main;
  }
}

/** artifacts.json: what the run created, fields with secrets masked, where it was made, and its cleanup status. */
export function artifactsReport(artifacts = [], ledger) {
  return artifacts.map(a => {
    const item = ledger?.items.find(i => i.kind === 'artifact' && i.artifact === a.name);
    const [scene, step] = String(a.stepKey ?? '').split('#');
    return { id: a.name, name: a.name, role: a.role, source: a.source, readOnly: !!a.readOnly,
      fields: Object.fromEntries(Object.entries(a.fields).map(([k, v]) => [k, a.secret?.includes(k) ? '***' : v])), secret: a.secret ?? [],
      scene: a.source === 'setup' ? 'setup' : scene || null, step: step ? Number(step) : null, scriptStep: a.scriptStep ?? null, shot: a.shot ?? null,
      cleanup: a.readOnly ? 'read-only' : !item ? 'none' : item.status === 'done' || item.status === 'pending' ? 'to undo' : item.status, ...(item?.undoError ? { cleanupError: item.undoError } : {}) };
  });
}

export function writeArtifacts(outDir, artifacts, ledger) {
  const list = artifactsReport(artifacts, ledger);
  if (list.length || fs.existsSync(path.join(outDir, 'artifacts.json'))) fs.writeFileSync(path.join(outDir, 'artifacts.json'), JSON.stringify({ schema: 'aft-artifacts/1', artifacts: list }, null, 2));
  return list;
}

/**
 * Finishes the undo of runs left with work pending (crashed, interrupted, teardown failed). Hooks run here; browser
 * steps need a browser: openBrowser() returns { undoSteps, close } (a one-shot signed-in session), or null to leave
 * them pending. Returns one result per ledger.
 */
export async function finishUndo(found, { log, openBrowser, deadline, hooks: withHooks = true }) {
  const results = [];
  for (const f of found) {
    const d = f.ledger.doc;
    const hookCtx = { dir: d.tourDir ?? f.dir, outDir: f.dir, baseUrl: d.baseUrl, log, tag: d.tag };
    let browser = null;
    const needsBrowser = f.ledger.pending({ retryFailed: true }).some(i => i.undo.steps);
    try {
      if (needsBrowser) browser = await openBrowser?.(d).catch(e => { log(`no browser for ${f.dir}: ${e.message.split('\n')[0]}`); return null; });
      log(`cleanup: ${f.dir}`);
      const r = await undoAll(f.ledger, { undoHooks: withHooks ? hooks => runHooks(hooks, hookCtx) : undefined, undoSteps: browser?.undoSteps, log, deadline, retryFailed: true });
      results.push({ run: f.dir, tour: d.tour, platform: d.platform ?? null, env: d.env ?? null, tag: d.tag ?? null, ...r });
    } finally { await browser?.close?.(); }
  }
  return results;
}

/** Earlier runs of this tour (same out folder, platform and environment) with undo still pending, newest last. */
export function earlierOpen(outDir, doc) {
  const base = path.dirname(outDir);
  return openLedgers(path.dirname(base), { name: path.basename(base), platform: doc.platform, env: doc.env })
    .filter(f => path.resolve(f.dir) !== path.resolve(outDir));
}

/**
 * On a shared environment: data a tour creates must carry {run.tag} (or be read-only), so parallel runs don't collide
 * and `aft cleanup --tag` can sweep leftovers. Returns warnings.
 */
export function sharedWarnings(cfg) {
  if (!cfg.shared) return [];
  const tagged = v => JSON.stringify(v ?? '').includes('{run.tag}');
  const out = [];
  for (const it of cfg.fixtureItems ?? []) if (it.setup?.length && !it.readOnly && !tagged(it.setup))
    out.push(`shared environment: fixture item "${it.name}" creates data without {run.tag} (tag it, or mark it "readOnly")`);
  for (const b of cfg.fixtureBrowser ?? []) if (b.steps?.length && !b.readOnly && !tagged(b.steps))
    out.push(`shared environment: fixture ${b.fixture}'s steps create data without {run.tag} (tag it, or mark the fixture "readOnly")`);
  for (const [i, s] of (cfg.scenes ?? []).entries()) for (const st of s.steps ?? []) if ('pin' in st && !st.readOnly && !tagged(st) && !tagged(s.steps))
    out.push(`shared environment: scene ${i + 1} pins "${st.pin}" but nothing in the scene uses {run.tag} (tag what it creates, or mark the pin "readOnly")`);
  return out;
}

/** Runs an environment's "reset" hooks (a local database snapshot, say). Never on a shared environment. */
export async function resetEnvironment(cfg, { env, dir, outDir, baseUrl, log }) {
  if (!cfg.reset?.length) throw new Failure('error', `environment ${env ?? '(default)'} has no "reset" hooks`);
  if (cfg.shared) throw new Failure('error', `environment ${env} is shared: it is never reset (remove "reset" or "shared")`);
  log(`reset: ${env}`);
  await runHooks(cfg.reset, { dir, outDir, baseUrl, log });
  return { env, hooks: cfg.reset.length };
}

export { Ledger };
