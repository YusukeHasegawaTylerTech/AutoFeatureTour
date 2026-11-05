// Agent primitives: a live browser on the app, signed in as a platform role, for looking and trying before writing a
// tour. Nothing here records a video or decides anything; each call returns facts about the page as JSON.
//
//   aft session start  [--platform <name>] [--target <env>] [--role <r>] [--headed] [--session <name>]
//   aft session status [--session <name>]      aft session stop [--session <name> | --all]
//   aft snapshot [--url <path>] [--screenshot]              URL, title, ARIA snapshot, visible text
//   aft locate "<target>"                                   how a step target resolves: matches, visible, alternatives
//   aft try-step '<step or [steps]>' [--url <path>]          run steps live (fragments too), result + snapshot after
//
// snapshot/locate/try-step use the running session (--session, or the only one for that platform) when there is
// one; otherwise they open a one-shot session for that call (slower: launch, sign in, close).
// A session is a detached process (src/session-daemon.mjs) with a small HTTP control port on 127.0.0.1, guarded by
// a random token; its state file is <tool>/.sessions/<name>.json. "stop" stops only what that session started (a
// launched service with "stop": false keeps running, as in a run) and never touches apps it found running.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeLogin, materialize, secretsOf, startServices } from './declarative.mjs';
import { expandSteps } from './platform.mjs';
import { stopProcess, Tour } from './recorder.mjs';
import { Capture } from './capture.mjs';
import { candidates, runSteps, settle, shown, StepError, suggest } from './steps.mjs';
import { scrub } from './triage.mjs';
import { sleep } from './util.mjs';
import { Workarounds } from './workarounds.mjs';

export const SESSION_SCHEMA = 'aft-session/1';
const SAFE = /^[A-Za-z0-9_-]+$/;
const daemonFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-daemon.mjs');

export const sessionsDir = toolRoot => path.join(toolRoot, '.sessions');

/** The default session name for an app: platform-env-role (or the host for a bare URL). */
export function sessionName(app, args) {
  const n = args.session ?? [app.platform?.name ?? (app.cfg.baseUrl ? new URL(app.cfg.baseUrl).hostname.replace(/[^A-Za-z0-9-]/g, '-') : 'app'), app.env ?? 'default', app.cfg.login?.role ?? 'anon'].join('-');
  if (!SAFE.test(n)) throw new Error(`Session names must match ${SAFE} (got "${n}")`);
  return n;
}

/** A live, unrecorded browser on the app, signed in, with the same readiness and error policy as a run. */
export class Session {
  constructor({ app, outDir, headed = false, log = () => {}, options = {} }) {
    Object.assign(this, { app, outDir, headed, log, options });
  }

  async start() {
    const cfg0 = this.app.cfg;
    if (!cfg0.baseUrl) throw new Error('no baseUrl: name a --platform (and --target), or pass --base-url');
    const { cfg, vars } = await materialize(cfg0);
    Object.assign(this, { cfg, vars, secrets: secretsOf(cfg) });
    const dir = this.app.platform?.dir ?? process.cwd();
    this.services = await startServices(cfg, vars, { outDir: this.outDir, log: this.log, dir });
    this.login = makeLogin(cfg, cfg0, this.app, { outDir: this.outDir, log: this.log, options: this.options, baseUrl: vars.baseUrl });
    await this.login.beforeStart();
    this.tour = new Tour({ outDir: this.outDir, dryRun: true, headless: !this.headed, viewport: cfg.viewport, mask: cfg.mask });
    this.tour.policy = cfg.appErrors ?? {};
    this.tour.data = { ...cfg.data };
    // Known issues are handled as in a run, so try-step and snapshot see what a run would.
    if (cfg.workarounds?.length) this.tour.workarounds = new Workarounds(cfg.workarounds, { baseUrl: vars.baseUrl + '/', timeouts: cfg.timeouts, ready: cfg.ready, log: this.log });
    this.startOpts = { storageState: this.login.state ?? undefined, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, trace: false, cursor: false };
    await this.tour.start(this.startOpts);
    await this.login.ensure(this.tour, this.startOpts);
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  status() {
    const page = this.tour?.page;
    return { platform: this.app.platform?.name ?? null, env: this.app.env ?? null, role: this.cfg?.login?.role ?? null, baseUrl: this.vars?.baseUrl,
      url: page && !page.isClosed() ? page.url() : null, startedAt: this.startedAt,
      services: (this.services?.services ?? []).map(({ name, health, started, stops }) => ({ name, health, started, stopsWithSession: !!stops })) };
  }

  /** Steps for this app: fragments from the platform (and data from any fixtures named) expanded. */
  expand(steps) {
    const dirs = [...(this.app.platform ? [path.join(this.app.platform.dir, 'fragments')] : []), process.cwd()];
    return expandSteps(steps, { dirs, data: this.cfg.data ?? {} });
  }

  stepOpts(report) {
    const c = this.cfg;
    return { baseUrl: this.vars.baseUrl + '/', timeouts: c.timeouts, report, ready: c.ready, errors: c.errors, retries: 0, unpaced: true, onError: 'fail', scene: 'try-step',
      allowMocks: !!c.allowMocks || !!this.options.allowMocks, outDir: this.outDir };
  }

  async goto(url) {
    if (url) await runSteps(this.tour, [{ goto: url }], this.stepOpts([]));
  }

  async snapshot({ url, screenshot = false, maxText = 20000 } = {}) {
    await this.goto(url);
    const page = this.tour.page;
    await settle(page, this.cfg.ready);
    const fired = this.tour.workarounds?.firings.length ?? 0;
    await this.tour.workarounds?.checkpoint(this.tour, { warnings: [] });
    const aria = await page.locator('body').ariaSnapshot({ timeout: 10000 }).catch(e => `(no ARIA snapshot: ${e.message.split('\n')[0]})`);
    const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).replace(/\n{3,}/g, '\n\n');
    let shot = null;
    if (screenshot) {
      shot = path.join(this.outDir, `snapshot-${Date.now()}.png`);
      await page.screenshot({ path: shot });
    }
    const out = { schema: 'aft-snapshot/1', url: page.url(), title: await page.title().catch(() => ''), aria, text: text.slice(0, maxText),
      truncated: text.length > maxText, ...(shot ? { screenshot: shot } : {}),
      ...(this.tour.workarounds?.firings.length > fired ? { workarounds: this.tour.workarounds.firings.slice(fired) } : {}) };
    return JSON.parse(scrub(JSON.stringify(out), this.secrets));
  }

  async locate(target, { url } = {}) {
    await this.goto(url);
    return locate(this.tour.page, target, { timeout: 0 });
  }

  /** Runs steps live; never throws for a failing step: returns ok, the class, each step's report entry and a snapshot. */
  async tryStep(stepOrSteps, { url } = {}) {
    await this.goto(url);
    const steps = this.expand([stepOrSteps].flat());
    const report = [];
    const t = this.tour;
    const marks = { net: t.networkFailures.length, con: t.consoleErrors.length, wa: t.workarounds?.firings.length ?? 0 };
    let failure = null;
    try { await runSteps(t, steps, this.stepOpts(report)); }
    catch (e) { failure = { class: e.failure ?? (e instanceof StepError ? 'script' : 'error'), message: e.message.split('\n')[0] }; }
    const snap = await this.snapshot({ maxText: 4000 });
    const out = {
      schema: 'aft-try-step/1', ok: !failure, ...(failure ? { class: failure.class, error: failure.message } : { class: 'ok' }),
      steps: report.map(r => ({ ...r, spec: shown(r.spec) })),
      network: t.networkFailures.slice(marks.net), console: t.consoleErrors.slice(marks.con),
      ...(t.workarounds ? { workarounds: t.workarounds.firings.slice(marks.wa) } : {}),
      after: { url: snap.url, title: snap.title, aria: snap.aria },
    };
    return JSON.parse(scrub(JSON.stringify(out), this.secrets));
  }

  // ---- Recording by hand (src/capture.mjs): the person acts in this (headed) browser, the steps are collected ----

  async recordStart({ outDir } = {}) {
    if (this.capture?.active) throw new Error('already recording: record-stop first');
    this.capture = new Capture(this.tour.page, { outDir: outDir ?? this.outDir, baseUrl: this.vars.baseUrl + '/', mask: this.cfg.mask, log: this.log });
    return this.capture.start();
  }

  recordSteps({ dropLast } = {}) {
    if (!this.capture) return { recording: false, steps: [] };
    return { recording: this.capture.active, steps: dropLast ? this.capture.dropLast() : this.capture.steps(), url: this.tour.page.url() };
  }

  async recordStop() {
    if (!this.capture) throw new Error('not recording: record-start first');
    const r = await this.capture.stop();
    this.capture = null;
    return JSON.parse(scrub(JSON.stringify({ recording: false, ...r }), this.secrets));
  }

  async stop() {
    await this.tour?.close().catch(() => {});
    for (const p of this.services?.procs ?? []) stopProcess(p);
    return { stopped: true, servicesStopped: (this.services?.services ?? []).filter(s => s.stops).map(s => s.name) };
  }
}

/**
 * How a step target resolves on the page, without acting: each candidate strategy in the order steps try them, its
 * match count and visible count, the one a step would use, and (when nothing or several match) the closest names.
 */
export async function locate(page, target) {
  const cands = candidates(page, target);
  const strategies = [];
  let chosen = null;
  for (const loc of cands) {
    const count = await loc.count().catch(() => 0);
    const visible = [];
    for (let i = 0; i < Math.min(count, 20); i++) if (await loc.nth(i).isVisible().catch(() => false)) visible.push(i);
    strategies.push({ strategy: loc.how, count, visible: visible.length });
    if (!chosen && visible.length) chosen = { strategy: loc.how, loc, visible };
  }
  const describe = async (loc, i) => loc.nth(i).evaluate(el => ({
    tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), id: el.id || null, name: el.getAttribute('aria-label') ?? el.getAttribute('name') ?? null, placeholder: el.getAttribute('placeholder'),
    text: (el.innerText ?? el.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    box: (r => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }))(el.getBoundingClientRect()),
  })).catch(() => null);
  const nth = typeof target === 'object' ? target.nth : undefined;
  const matches = chosen ? (await Promise.all(chosen.visible.slice(0, 10).map(i => describe(chosen.loc, i)))).map((m, k) => ({ index: chosen.visible[k], ...m })) : [];
  const resolved = !!chosen && (nth === undefined || chosen.visible.includes(nth));
  return {
    schema: 'aft-locate/1', target, url: page.url(), resolved,
    ...(chosen ? { strategy: chosen.strategy, uses: nth ?? chosen.visible[0] } : {}),
    ambiguous: !!chosen && nth === undefined && chosen.visible.length > 1,
    matches, strategies,
    alternatives: !resolved || (chosen && chosen.visible.length > 1 && nth === undefined) ? await suggest(page, target) : [],
  };
}

/** Parses a target or step argument: JSON when it looks like JSON, else a plain string target. */
export function parseArg(s, what) {
  const t = String(s ?? '').trim();
  if (!t) throw new Error(`Give a ${what}`);
  if (/^[[{"]/.test(t)) { try { return JSON.parse(t); } catch (e) { throw new Error(`${what} isn't valid JSON: ${e.message}`); } }
  return t;
}

// ---- Daemon control (used by the CLI) ------------------------------------------------------------------------------

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function readSessions(toolRoot) {
  const dir = sessionsDir(toolRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean).map(s => ({ ...s, alive: !!s.pid && alive(s.pid) }));
}

export async function call(s, op, params = {}) {
  const res = await fetch(`http://127.0.0.1:${s.port}/`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aft-token': s.token },
    body: JSON.stringify({ op, ...params }) });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `session ${s.name}: HTTP ${res.status}`), { failure: body.class });
  return body;
}

/** Starts a session daemon and waits until it's ready (or failed). */
export async function startDaemon({ toolRoot, name, args, outDir, timeoutMs = 15 * 60 * 1000 }) {
  const dir = sessionsDir(toolRoot);
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, `${name}.json`);
  const existing = readSessions(toolRoot).find(s => s.name === name);
  if (existing?.alive && existing.status === 'ready') return { ...existing, reused: true };
  if (existing) fs.rmSync(stateFile, { force: true });
  const logFile = path.join(outDir, 'session.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [daemonFile], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: process.cwd(),
    env: { ...process.env, AFT_SESSION: JSON.stringify({ toolRoot, name, args, outDir, stateFile }) } });
  child.unref();
  const until = Date.now() + timeoutMs;
  for (;;) {
    await sleep(500);
    const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    if (s?.status === 'ready') return s;
    if (s?.status === 'failed') { fs.rmSync(stateFile, { force: true }); throw Object.assign(new Error(`session ${name} didn't start: ${s.error}`), { failure: s.class }); }
    if (!alive(child.pid)) throw new Error(`session ${name} exited while starting; see ${logFile}`);
    if (Date.now() > until) throw new Error(`session ${name} didn't become ready in ${timeoutMs / 60000} min; see ${logFile}`);
  }
}
