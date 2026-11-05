// The process behind `aft stage` (src/stage.mjs): runs a tour unrecorded up to its point, then keeps the browser,
// services and data and serves a session's control port. Started detached with
// AFT_STAGE={ toolRoot, name, outDir, stateFile, file, args, point, keep, sourceRun }. Logs go to <outDir>/stage.log.
//
// POST / (header x-aft-token) { "op": "status" | "snapshot" | "locate" | "try-step" | "record-start" | "record-steps" | "record-stop" | "open" | "stop", ... } → JSON.
// "stop" { keep }: undo the ledger in reverse (browser steps in this browser, then hooks) unless keep, stop the
// services it started, close the browser, mark the run "ended" and exit.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadTourJson } from './declarative.mjs';
import { classify, Failure } from './failures.mjs';
import { stopProcess, Tour } from './recorder.mjs';
import { Session } from './session.mjs';
import { StopRun } from './steps.mjs';
import { finalize } from './triage.mjs';
import { describePoint, markRun, rangeFor } from './stage.mjs';
import { log, run } from './util.mjs';

const job = JSON.parse(process.env.AFT_STAGE);
const { toolRoot, name, outDir, stateFile, file, args = {}, point = {} } = job;
const token = crypto.randomBytes(24).toString('hex');
const writeState = s => { const tmp = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, stateFile); };
const base = { schema: 'aft-session/1', name, pid: process.pid, outDir, log: path.join(outDir, 'stage.log') };

let def, t, ctx, session, server, stage = {}, live = {}, queue = Promise.resolve(), running = null, stopping = false, handoff = null;

const state = extra => writeState({ ...base, status: 'ready', ...(server ? { port: server.address().port, token } : {}), ...(session ? session.status() : {}),
  platform: def?.platform ?? null, env: def?.env ?? null, ...extra, stage });

function stageInfo() {
  const summary = ctx?.ledger?.summary() ?? [];
  return {
    artifacts: (ctx?.artifacts ?? []).map(a => ({ name: a.name, role: a.role, fields: a.fields })),   // secret fields are *** already
    toUndo: summary.filter(i => i.toUndo).map(i => ({ name: i.name, kind: i.kind })),
  };
}

async function end({ keep = false } = {}) {
  if (stopping) return { error: 'already stopping' };
  stopping = true;
  let undo = null;
  if (!keep) {
    log('ending the stage: undoing what it set up, newest first');
    await ctx?.undo?.().catch(e => log(`undo failed: ${e.message}`));
    const items = ctx?.ledger?.doc.items ?? [];
    undo = { undone: items.filter(i => i.status === 'undone').length, failed: items.filter(i => i.status === 'undo-failed').map(i => ({ name: i.name, error: i.undoError })),
      left: items.filter(i => i.undo && ['pending', 'done'].includes(i.status)).length };
  } else log('ending the stage, keeping its data (the ledger stays pending; aft cleanup <run> undoes it later)');
  if (ctx?.ledger) { ctx.ledger.doc.stage = { ...ctx.ledger.doc.stage, live: false, ...(keep ? { kept: true } : {}) }; ctx.ledger.save(); }
  await handoff?.context.close().catch(() => {});
  await t?.close().catch(() => {});
  const stopped = [];
  for (const p of live.services?.procs ?? []) { stopProcess(p); stopped.push(p.pid); }
  markRun(outDir, 'ended', { kept: keep, ...(undo ? { undo } : {}) });
  fs.rmSync(stateFile, { force: true });
  setTimeout(() => { server?.close(); process.exit(0); }, 200);
  return { kept: keep, undo, servicesStopped: (live.services?.services ?? []).filter(s => s.stops).map(s => s.name) };
}

// The stage's data is live on purpose (undone at `stage end`), not a leftover for the review to flag.
const liveData = list => list.map(({ toUndo, ...x }) => (toUndo ? { ...x, live: true } : x));

async function stageTour() {
  def = loadTourJson(file, { env: args.target, role: args.role, toolRoot });
  const scenes = def.scenes.map((s, i) => ({ ...s, id: `scene-${String(i + 1).padStart(2, '0')}`, cues: [] }));
  const role = def.raw.login?.role ?? null;
  stage = { state: 'staging', tour: def.name, tourFile: file, runDir: outDir, sourceRun: job.sourceRun ?? null, platform: def.platform ?? null, env: def.env ?? null,
    role, as: args.as ?? def.raw.stage?.role ?? role, point, keep: !!job.keep, note: def.raw.stage?.note ?? null, startedAt: new Date().toISOString(), warnings: [...(def.warnings ?? [])] };
  state({ status: 'starting' });
  markRun(outDir, 'staging');
  t = new Tour({ outDir, dryRun: true, narration: scenes.filter(s => !s.offCamera).map(s => ({ id: s.id, seconds: 1 })), headless: !!args.headless, viewport: def.viewport, mask: def.mask });
  const secrets = [];
  ctx = { tour: t, scenes, outDir, options: { env: args.target, freshLogin: args.freshLogin }, toolRoot, targetDir: path.dirname(file), platformDir: def.platformFolder ?? path.dirname(file),
    log, run, dryRun: true, report: [], range: rangeFor(point), secrets, stage: { deferUndo: true } };
  const started = Date.now();
  let error = null;
  log(`staging ${def.name} (${describePoint(point)})${def.env ? ` on ${def.env}` : ''}`);
  try {
    await def.record(ctx);
    stage.reached = point.untilScene ? `stopped after scene ${point.untilScene} (the last)` : 'the end of the tour';
  } catch (e) {
    if (e instanceof StopRun) stage.reached = e.message.replace(/ \(--until-step \d+\)$/, '');
    else error = e;
  }
  live = ctx.live ?? {};
  stage.tag = ctx.ledger?.doc.tag ?? null;
  const steps = ctx.report;
  const last = [...steps].reverse().find(s => s.ok);
  if (!error && last) stage.reached += ` (last: ${last.scene} step ${last.step})`;
  if (t.page && !t.page.isClosed()) await t.screenshot(error ? 'failure' : 'stage');
  const report = await finalize({ outDir, def, steps, tour: t, error, ms: Date.now() - started, secrets, fixtures: liveData(ctx.fixtures ?? ctx.ledger?.summary() ?? []), artifacts: ctx.artifacts ?? [],
    warnings: [...(def.warnings ?? []), ...(error ? [] : [`stage: ${stage.reached}`])] }).catch(e => { log(`report failed: ${e.message}`); return null; });
  if (error) {
    Object.assign(stage, { state: 'failed', error: (report?.error ?? error.message).split('\n')[0], class: classify(error), failing: report?.failing ?? null });
    log(`stage failed: ${error.stack ?? error.message}`);
    log(`stage failed: ${stage.error}; the browser stays open at the failure`);
  } else stage.state = 'staged';
  // The person tests as another role: a second window with that role's saved login, on the same page.
  if (!error && stage.as && stage.as !== role && t.browser) {
    const auth = def.authFile(stage.as);
    if (auth && fs.existsSync(auth)) {
      const context = await t.browser.newContext({ viewport: def.viewport, storageState: auth, ignoreHTTPSErrors: live.cfg?.ignoreHTTPSErrors });
      const page = await context.newPage();
      await page.goto(t.page.url()).catch(e => log(`hand-off: ${e.message.split('\n')[0]}`));
      handoff = { context, page, main: t.page };
      t.page = page;
      log(`hand-off: a window signed in as ${stage.as}`);
    } else stage.warnings.push(`no saved login for role "${stage.as}" (aft login --role ${stage.as}${def.env ? ` --target ${def.env}` : ''}): handed off as ${role ?? 'the tour role'}`);
  }
  if (live.cfg) {
    session = Object.assign(new Session({ app: { platform: def.platformFolder ? { name: def.platform, dir: def.platformFolder } : null, env: def.env, cfg: live.cfg }, outDir, log }),
      { tour: t, cfg: live.cfg, vars: live.vars, secrets, services: live.services, startedAt: stage.startedAt });
  }
  Object.assign(stage, stageInfo());
  markRun(outDir, stage.state, { reached: stage.reached ?? null, ...(error ? { class: stage.class, error: stage.error } : {}), tag: stage.tag });
}

function serve() {
  server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.headers['x-aft-token'] !== token) return send(403, { error: 'forbidden' });
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
      if (msg.op === 'status') return send(200, { ...base, status: 'ready', ...(session?.status() ?? {}), stage, ...(running ? { busy: running } : {}) });
      if (msg.op === 'record-steps') return send(200, session?.recordSteps(msg) ?? { recording: false, steps: [] });
      if (running && msg.op !== 'stop') return send(409, { error: `stage ${name} is busy: a "${running}" call is still running`, class: 'error' });
      if (msg.op !== 'stop') running = msg.op;
      queue = queue.then(async () => {
        try {
          const need = () => { if (!session || !t.page || t.page.isClosed()) throw new Failure('error', `stage ${name} has no browser (it failed before the browser started)`); };
          switch (msg.op) {
            case 'snapshot': need(); return send(200, await session.snapshot(msg));
            case 'locate': need(); return send(200, await session.locate(msg.target, msg));
            case 'try-step': need(); return send(200, await session.tryStep(msg.step, msg));
            case 'record-start': need(); return send(200, await session.recordStart(msg));
            case 'record-stop': need(); return send(200, await session.recordStop());
            case 'open': need(); await t.page.bringToFront(); return send(200, { url: t.page.url() });
            case 'stop': return send(200, { ...base, ...(await end({ keep: !!msg.keep })) });
            default: return send(400, { error: `unknown op ${msg.op}` });
          }
        } catch (e) {
          log(`${msg.op} failed: ${e.stack ?? e}`);
          send(500, { error: e.message.split('\n')[0], class: e.failure ?? classify(e) });
        } finally {
          if (msg.op !== 'stop') { running = null; if (!stopping && t?.page && !t.page.isClosed()) state({}); }
        }
      });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', r));
}

process.on('SIGTERM', () => end({ keep: true }));
process.on('SIGINT', () => end({ keep: true }));
(async () => {
  try { await stageTour(); }
  catch (e) {
    // The tour couldn't even be loaded (a config error): nothing was set up.
    log(`failed to stage: ${e.stack ?? e}`);
    stage = { ...stage, state: 'failed', error: e.message.split('\n')[0], class: classify(e) };
    markRun(outDir, 'failed', { class: stage.class, error: stage.error });
    if (!ctx?.ledger?.doc.items.length) {
      writeState({ ...base, status: 'failed', error: stage.error, class: stage.class, stage });
      await t?.close().catch(() => {});
      setTimeout(() => process.exit(1), 300);
      return;
    }
  }
  await serve();
  state({});
  log(`${stage.state} on 127.0.0.1:${server.address().port}${t?.page && !t.page.isClosed() ? ` at ${t.page.url()}` : ''}`);
})();
