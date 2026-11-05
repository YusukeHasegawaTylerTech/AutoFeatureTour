// Staging: "do / redo until here". Runs a tour without recording up to a chosen point (after setup, after scene N,
// after step N), then hands off the live app: the browser stays open (headed), signed in, with the tour's data in
// place, for testing by hand from there. Nothing is undone until the stage ends.
//
//   aft stage <tour.json | run folder> [--target env] [--as role] [--until-scene N [--step J] | --until-step N | --setup-only]
//             [--keep] [--redo [--force]] [--headless]
//   aft stage list                 aft stage end <name> [--keep]
//
// A stage is a detached process (src/stage-daemon.mjs) that runs the tour's pipeline (src/declarative.mjs) with
// ctx.stage set: every step unpaced, no video, TTS or trace; verifies still run, so a broken state fails loudly; the
// end-of-run undo is deferred. It then serves the same control port as a session (status, snapshot, locate,
// try-step) plus "open" (bring the browser to the front) and "stop" ({ keep }: undo its ledger in reverse, or leave
// it). Its state file is .sessions/stage-<tour>-<env>.json: one stage per tour and environment; --redo ends the
// current one (undoing its data) and stages again. The run folder gets run.json (command "stage", status
// staging | staged | failed | ended), report.json, ledger.json, artifacts.json, screens/stage.png; latest.json is
// never touched.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call, readSessions, sessionsDir } from './session.mjs';
import { sleep } from './util.mjs';

const daemonFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage-daemon.mjs');
const safe = s => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

/** One stage per tour and environment. */
export const stageName = (tour, env) => `stage-${safe(tour)}-${safe(env ?? 'default')}`;

/** The tour file to stage: a tour.json, or a run folder (the script that ran there: tour.json, else run.json's input). */
export function stageSource(src) {
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) return null;
  if (fs.statSync(abs).isFile()) return { file: abs, runDir: null };
  const inRun = path.join(abs, 'tour.json');
  if (fs.existsSync(inRun)) return { file: inRun, runDir: abs };
  const run = path.join(abs, 'run.json');
  if (fs.existsSync(run)) {
    const r = JSON.parse(fs.readFileSync(run, 'utf8'));
    const input = r.input?.[0] ?? r.args?.script;
    if (input && fs.existsSync(path.resolve(input))) return { file: path.resolve(input), runDir: abs, env: r.args?.target ?? r.args?.env };
  }
  return { file: null, runDir: abs };
}

/** The stop point from the flags: { untilScene } | { untilStep } | { setupOnly } | {} (the whole tour). */
export function stagePoint(args) {
  const n = k => { const v = Number(args[k]); if (!Number.isInteger(v) || v < 1) throw new Error(`--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} takes a number from 1 (got "${args[k]}")`); return v; };
  const given = ['untilScene', 'untilStep', 'setupOnly'].filter(k => args[k] !== undefined && args[k] !== false);
  if (given.length > 1) throw new Error('give one of --until-scene, --until-step, --setup-only');
  if (args.setupOnly) return { setupOnly: true };
  if (args.step !== undefined && args.untilScene === undefined) throw new Error('--step goes with --until-scene (script step J of scene N)');
  if (args.untilScene !== undefined) return { untilScene: n('untilScene'), ...(args.step !== undefined ? { step: n('step') } : {}) };
  if (args.untilStep !== undefined) return { untilStep: n('untilStep') };
  return {};
}

/** The engine's range for a point (see runSteps / the scene loop in declarative.mjs). */
export const rangeFor = point => (point.setupOnly ? { n: 0, from: 0, until: 0, scenes: 0 }
  : point.untilScene ? { n: 0, from: 0, until: 0, scenes: point.untilScene, ...(point.step ? { step: point.step } : {}) }
    : point.untilStep ? { n: 0, from: 0, until: point.untilStep } : null);

export const describePoint = point => (point.setupOnly ? 'setup only' : point.untilScene ? `until scene ${point.untilScene}${point.step ? ` · step ${point.step}` : ''}` : point.untilStep ? `until step ${point.untilStep}` : 'the whole tour');

/** Stages (live or not) with what a card shows; never the control token. */
export function listStages(toolRoot) {
  return readSessions(toolRoot).filter(s => s.name?.startsWith('stage-')).map(stageView);
}

export function stageView(s) {
  const { token, port, ...rest } = s;
  const st = rest.stage ?? {};
  return { name: rest.name, alive: !!rest.alive, pid: rest.pid, state: rest.alive ? st.state ?? rest.status : st.state === 'ended' ? 'ended' : 'dead',
    tour: st.tour ?? null, tourFile: st.tourFile ?? null, platform: rest.platform ?? st.platform ?? null, env: rest.env ?? st.env ?? null,
    role: st.role ?? rest.role ?? null, as: st.as ?? null, point: st.point ?? {}, reached: st.reached ?? null, runDir: st.runDir ?? rest.outDir ?? null,
    tag: st.tag ?? null, keep: !!st.keep, note: st.note ?? null, url: rest.url ?? null, startedAt: st.startedAt ?? rest.startedAt ?? null,
    error: st.error ?? rest.error ?? null, class: st.class ?? rest.class ?? null, artifacts: st.artifacts ?? [], toUndo: st.toUndo ?? [], warnings: st.warnings ?? [],
    log: rest.log ?? null };
}

/**
 * Starts the stage daemon and waits until it reaches its point (staged) or fails; its log is copied to `echo` as it
 * grows. Returns the state file's contents.
 */
export async function startStage({ toolRoot, name, outDir, job, echo = () => {}, timeoutMs = 30 * 60 * 1000 }) {
  const dir = sessionsDir(toolRoot);
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, `${name}.json`);
  fs.rmSync(stateFile, { force: true });
  const logFile = path.join(outDir, 'stage.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [daemonFile], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: process.cwd(),
    env: { ...process.env, AFT_STAGE: JSON.stringify({ toolRoot, name, outDir, stateFile, ...job }) } });
  child.unref();
  const until = Date.now() + timeoutMs;
  let pos = 0;
  const tail = () => {
    try {
      const size = fs.statSync(logFile).size;
      if (size <= pos) return;
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      echo(buf.toString('utf8'));
    } catch { /* not there yet */ }
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (;;) {
    await sleep(400);
    tail();
    let s = null;
    try { s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null; } catch { /* being renamed */ }
    if (s?.stage && ['staged', 'failed'].includes(s.stage.state) && s.status === 'ready') { tail(); return s; }
    if (s?.status === 'failed') { tail(); return s; }
    if (!alive(child.pid)) { tail(); throw new Error(`stage ${name} exited while staging; see ${logFile}`); }
    if (Date.now() > until) throw new Error(`stage ${name} didn't reach its point in ${timeoutMs / 60000} min; see ${logFile}`);
  }
}

/**
 * Ends a stage: undoes its data in reverse (unless keep), stops what it started, closes the browser. A stage whose
 * process is gone is finished by `undoDead` (the same cleanup as `aft cleanup <run>`). Returns { name, kept, undo }.
 */
export async function endStage(toolRoot, s, { keep, undoDead } = {}) {
  const file = path.join(sessionsDir(toolRoot), `${s.name}.json`);
  const k = keep ?? !!s.stage?.keep;
  let r;
  if (s.alive && s.port) r = await call(s, 'stop', { keep: k });
  else {
    const runDir = s.stage?.runDir ?? s.outDir;
    r = { kept: k, undo: null, note: 'its process was gone' };
    if (runDir) {
      const lf = path.join(runDir, 'ledger.json');
      if (fs.existsSync(lf)) {
        const doc = JSON.parse(fs.readFileSync(lf, 'utf8'));
        doc.stage = { ...doc.stage, live: false, ...(k ? { kept: true } : {}) };
        fs.writeFileSync(lf, JSON.stringify(doc, null, 2));
      }
      if (!k && undoDead) r.undo = await undoDead(runDir);
      markRun(runDir, 'ended', { kept: k });
    }
  }
  fs.rmSync(file, { force: true });
  return { name: s.name, ...r };
}

/** run.json of a stage's run folder: status staging | staged | failed | ended. */
export function markRun(runDir, status, extra = {}) {
  const f = path.join(runDir, 'run.json');
  const info = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { command: 'stage' };
  Object.assign(info, { status, ...(['ended', 'failed'].includes(status) ? { finishedAt: new Date().toISOString() } : {}), ...extra });
  fs.writeFileSync(f, JSON.stringify(info, null, 2));
}
