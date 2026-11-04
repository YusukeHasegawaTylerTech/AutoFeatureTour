// tour.json: a whole tour as data, for any app. Written by hand, or by `aft plan` (heuristic or LLM).
//
// {
//   "name": "my-app",                           // run folder name; "target" (default: name) names the auth folder
//   "baseUrl": "http://localhost:3000",          // overridden by --base-url, then BASE_URL, then the chosen environment
//   "environments": {                           // pick with --env; same script, different deployments
//     "local": { "baseUrl": "http://localhost:3000" },
//     "test":  { "baseUrl": "https://myapp-test.example.com", "timeouts": { "verify": 30000 } }
//   },
//   "launch": {                                 // optional; or a list of these (an API and a web server, say)
//     "command": "npm start", "cwd": "../my-app", "env": { "PORT": "{port}" },
//     "port": "auto",                           // a free port per run, so concurrent runs don't clash
//     "healthUrl": "{baseUrl}/health", "anyStatus": true, "timeoutSeconds": 120,
//     "stop": true                              // false: leave it running after the run (slow-starting services)
//   },                                          // already answering at healthUrl? it's used as is and never stopped
//   "ready": { "busy": ".spinner, .loading", "stableMs": 1500, "timeout": 60000 },  // instead of network idle
//   "appErrors": { "network": "fail", "console": "warn", "pageErrors": "warn", "ignore": ["/telemetry", "favicon"] },
//   "trace": true,                               // false: no trace.zip (it holds full network traffic and DOM)
//   "login": { ..., "signedIn": "<css>", "checkPath": "/home", "maxAgeMinutes": 30 },  // re-login on expiry, off camera
//   "retries": 1,                                // rule-based retries of action steps that time out (checks: never)
//   "errors": { "selector": ".error-dialog", "text": "error|exception" },  // the app's error UI: a step showing it fails
//   "login": { "role": "clerk", "steps": [ { "goto": "/login" }, { "fill": "Email", "text": "{env:DEMO_USER}" }, ... ] },
//   "timeouts": { "action": 10000, "verify": 15000, "waitFor": 30000, "navigation": 30000 },
//   "viewport": { "width": 1440, "height": 810 },
//   "voice": "Microsoft Zira Desktop", "pronounce": { "SQL": "sequel" },
//   "hooks": {                                  // test data: run off camera before the browser starts / after it closes
//     "setup":    [ { "run": "npm run seed:demo", "cwd": "../my-app" }, { "http": { "method": "POST", "url": "{baseUrl}/api/test/reset" } } ],
//     "teardown": [ { "node": "hooks/cleanup.mjs" } ]  // hooks get BASE_URL and RUN_DIR in their environment
//   },
//   "mask": { "selectors": [".ssn", "[data-pii]"], "patterns": ["\b\d{3}-\d{2}-\d{4}\b"] },  // blurred on screen
//   "onError": "skip",                          // "fail" (default) or "skip" steps that can't be done ("verify" always fails)
//   "story": { "id": "RMS-6142", "title": "…", "acceptanceCriteria": ["…"] },
//   "scenes": [
//     { "title": "Welcome", "narration": "…", "url": "/", "criteria": [1], "steps": [ { "point": "Dashboard" } ] }
//   ]
// }
//
// Login: with a saved state (auth/<target>[-<env>]/<role>.json from `aft login`) it's loaded into the browser;
// otherwise the login steps run off camera before the first scene and the state is saved for next time.
// A scene's "url" is opened off camera just before it starts. "{env:NAME}" in any string reads an environment
// variable (or .env), so credentials stay out of the file.

import fs from 'node:fs';
import path from 'node:path';
import { authFile, saveLogin } from './auth.mjs';
import { probe, startProcess, stopProcess, waitForHttp } from './recorder.mjs';
import { Failure } from './failures.mjs';
import { runSteps, settle } from './steps.mjs';
import { freePort, run } from './util.mjs';

/** Runs setup/teardown hooks: a shell command, an HTTP call, or a Node script. */
async function runHooks(hooks = [], { dir, outDir, baseUrl, log }) {
  const env = { ...process.env, BASE_URL: baseUrl, RUN_DIR: outDir };
  for (const h of hooks) {
    if (h.run) { log(`hook: ${h.run}`); await run(h.run, [], { cwd: path.resolve(dir, h.cwd ?? '.'), env, shell: true }); }
    else if (h.node) { log(`hook: node ${h.node}`); await run(process.execPath, [path.resolve(dir, h.node), ...(h.args ?? [])], { cwd: dir, env }); }
    else if (h.http) {
      const { method = 'POST', url, headers = {}, body } = h.http;
      log(`hook: ${method} ${url}`);
      const res = await fetch(new URL(url, baseUrl + '/'), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      if (!res.ok && !h.optional) throw new Error(`hook ${method} ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    } else throw new Error(`Unknown hook ${JSON.stringify(h)} (run, node or http)`);
  }
}

/** A problem with the tour file itself; the CLI prints it without a stack trace (exit 1). */
export class ConfigError extends Error {}

/** Replaces {env:NAME} and {key} placeholders in every string of a JSON value. */
function fill(value, vars) {
  if (typeof value === 'string')
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => process.env[k] ?? '')
      .replace(/\{([A-Za-z]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map(v => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

export function validate(cfg, file) {
  const problems = [];
  if (!cfg.baseUrl) problems.push('no target: add "baseUrl" or "environments" to the tour, or pass --base-url <url> / set BASE_URL / --target <environment>');
  if (!Array.isArray(cfg.scenes) || !cfg.scenes.length) problems.push('scenes must be a non-empty array');
  (cfg.scenes ?? []).forEach((s, i) => {
    if (!s.title) problems.push(`scenes[${i}].title is required`);
    if (!s.narration) problems.push(`scenes[${i}].narration is required`);
    if (s.steps && !Array.isArray(s.steps)) problems.push(`scenes[${i}].steps must be an array`);
  });
  if (problems.length) throw new ConfigError(`${file}:\n  ${problems.join('\n  ')}`);
}

/** Applies the environment, then BASE_URL, then --base-url. */
export function resolveConfig(raw, { env, baseUrl } = {}) {
  let cfg = { ...raw };
  if (env) {
    const e = raw.environments?.[env];
    if (!e) throw new ConfigError(`No environment "${env}" in the tour (has: ${Object.keys(raw.environments ?? {}).join(', ') || 'none'})`);
    cfg = { ...cfg, ...e, timeouts: { ...raw.timeouts, ...e.timeouts } };
  }
  if (process.env.BASE_URL) cfg.baseUrl = process.env.BASE_URL;
  if (baseUrl) cfg.baseUrl = baseUrl;
  return cfg;
}

export const authTarget = (cfg, env) => `${cfg.target ?? cfg.name}${env ? `-${env}` : ''}`;

/** Loads tour.json as a tour definition the CLI can run, like a .tour.mjs module. */
export function loadTourJson(file, { env, baseUrl } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(`${file}: not valid JSON (${e.message})`); }
  raw.name ??= path.basename(file).replace(/\.tour\.json$|\.json$/, '');
  const cfg0 = resolveConfig(raw, { env, baseUrl });
  validate(cfg0, file);
  const dir = path.dirname(path.resolve(file));
  return {
    name: raw.name,
    story: raw.story,
    raw: cfg0,
    voice: raw.voice,
    pronounce: raw.pronounce,
    viewport: raw.viewport,
    mask: cfg0.mask,
    scenes: raw.scenes.map((s, i) => ({ number: i + 1, title: s.title, narration: s.narration })),
    async record(ctx) {
      const port = cfg0.launch?.port === 'auto' ? await freePort() : cfg0.launch?.port;
      const vars = { port: port ?? '' };
      vars.baseUrl = fill(cfg0.baseUrl, vars).replace(/\/$/, '');
      const cfg = fill(cfg0, vars);
      // Values marked secret (resolved from the environment) are scrubbed from every report and bundle file.
      ctx.secrets?.push(...[...(cfg.login?.steps ?? []), ...cfg.scenes.flatMap(s => s.steps ?? [])].filter(s => s.secret && s.text).map(s => s.text));
      const procs = [];
      let setupDone = false;
      const hookCtx = { dir, outDir: ctx.outDir, baseUrl: vars.baseUrl, log: ctx.log };
      try {
        for (const [n, l] of [cfg.launch ?? []].flat().entries()) {
          const health = l.healthUrl ?? vars.baseUrl;
          const label = l.name ?? (n ? `service ${n + 1}` : 'app');
          if (await probe(health, { any: l.anyStatus })) { ctx.log(`${label}: already running at ${health}; using it (it won't be stopped)`); continue; }
          if (!l.command) throw new Error(`${label} didn't come up: nothing answers at ${health} and the tour has no launch command for it`);
          const logFile = path.join(ctx.outDir, `${label.replace(/[^A-Za-z0-9_-]+/g, '-')}.log`);
          ctx.log(`${label}: starting (${l.command}); log: ${logFile}`);
          const proc = startProcess(l.command, [], { shell: true, cwd: path.resolve(dir, l.cwd ?? '.'), env: l.env, logFile });
          if (l.stop !== false) procs.push(proc);
          await waitForHttp(health, { ms: (l.timeoutSeconds ?? 120) * 1000, any: l.anyStatus, hint: `see ${logFile}` });
          ctx.log(`${label}: up at ${health}${l.stop === false ? ' (left running afterwards)' : ''}`);
        }
        await runHooks(cfg.hooks?.setup, hookCtx);
        setupDone = true;
        const state = cfg.login ? authFile(ctx.toolRoot, authTarget(cfg, ctx.options.env), ctx.options.role ?? cfg.login.role) : null;
        // Credentials the login steps need ({env:NAME} references that are empty mean we can't sign in by ourselves).
        const missingCreds = [...JSON.stringify(cfg0.login?.steps ?? []).matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1]).filter(k => !process.env[k]);
        const canLogin = !!cfg.login?.steps?.length && !missingCreds.length;
        const cannot = () => (!cfg.login?.steps?.length ? `the tour has no login steps: run aft login <tour.json> --manual${ctx.options.env ? ` --target ${ctx.options.env}` : ''}`
          : `credentials missing: set ${missingCreds.join(', ')} (environment or .env)`);
        const signIn = async why => {
          if (!canLogin) throw new Failure('login', `${why}, and the tour can't sign in by itself: ${cannot()}`);
          // In a separate browser that is neither recorded nor traced, so credentials never reach the run's files.
          ctx.log(`${why}: signing in (separate browser, not recorded)`);
          await saveLogin({ baseUrl: vars.baseUrl + '/', steps: cfg.login.steps, file: state, viewport: cfg.viewport, timeouts: cfg.timeouts, ready: cfg.ready,
            ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, failureShot: path.join(ctx.outDir, 'login-failure.png'), signedIn: cfg.login.signedIn });
        };
        let fresh = false;
        if (cfg.login) {
          const age = fs.existsSync(state) ? (Date.now() - fs.statSync(state).mtimeMs) / 60000 : null;
          const why = age === null ? 'no saved login' : ctx.options.freshLogin ? '--fresh-login' : cfg.login.maxAgeMinutes && age > cfg.login.maxAgeMinutes ? `saved login is ${Math.round(age)} min old (maxAgeMinutes ${cfg.login.maxAgeMinutes})` : null;
          if (why) { await signIn(why); fresh = true; }
        }
        const t = ctx.tour;
        t.policy = cfg.appErrors ?? {};
        const startOpts = { storageState: state ?? undefined, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, trace: cfg.trace !== false };
        await t.start(startOpts);
        const opts = { baseUrl: vars.baseUrl + '/', timeouts: cfg.timeouts, report: ctx.report, ready: cfg.ready, errors: cfg.errors, retries: cfg.retries ?? 1,
          range: ctx.range,
          onError: ctx.dryRun ? 'collect' : ctx.options.onError ?? cfg.onError ?? 'fail' };
        // Check the session where the tour starts (off camera: before the first scene, so it's cut from the video).
        const startAt = vars.baseUrl + '/' + String(cfg.login?.checkPath ?? cfg.startPath ?? cfg.scenes[0]?.url ?? '').replace(/^\//, '');
        const signedIn = async () => {
          await t.page.goto(startAt, { timeout: cfg.timeouts?.navigation ?? 30000 });
          await settle(t.page, cfg.ready);
          if (!cfg.login?.signedIn) return true;
          return t.page.locator(cfg.login.signedIn).first().waitFor({ timeout: fresh ? cfg.ready?.timeout ?? 30000 : cfg.timeouts?.waitFor ?? 15000 }).then(() => true, () => false);
        };
        if (!(await signedIn())) {
          if (fresh) throw new Failure('login', `signed in, but ${cfg.login.signedIn} isn't on ${t.page.url()}: check login.signedIn / login.checkPath in the tour`);
          await signIn('saved login expired');
          fresh = true;
          await t.restart(startOpts); // a fresh recorded context with the new session; nothing has been filmed yet
          if (!(await signedIn())) throw new Failure('login', `signed in again, but ${cfg.login.signedIn} isn't on ${t.page.url()}: check login.signedIn / login.checkPath`);
          ctx.log('saved login expired; signed in again');
        }
        for (const [i, s] of cfg.scenes.entries()) {
          const id = ctx.scenes[i].id;
          if (s.url) await runSteps(t, [{ goto: s.url }], { ...opts, unpaced: true, scene: `${id} (url)` });
          await t.scene(id, () => runSteps(t, s.steps ?? [], { ...opts, scene: id, criteria: s.criteria ?? [] }));
          ctx.progress?.();
        }
        await t.finish({ baseUrl: vars.baseUrl });
      } finally {
        if (setupDone) await runHooks(cfg.hooks?.teardown, hookCtx).catch(e => ctx.log(`teardown failed: ${e.message}`));
        for (const p of procs) stopProcess(p);
      }
    },
  };
}
