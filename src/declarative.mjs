// tour.json: a whole tour as data, for any app. Written by hand, or by `aft plan` (heuristic or LLM).
//
// {
//   "name": "my-app",                           // run folder name; "target" (default: name) names the auth folder
//   "baseUrl": "http://localhost:3000",          // overridden by --base-url, then BASE_URL, then the chosen environment
//   "environments": {                           // pick with --env; same script, different deployments
//     "local": { "baseUrl": "http://localhost:3000" },
//     "test":  { "baseUrl": "https://myapp-test.example.com", "timeouts": { "verify": 30000 } }
//   },
//   "launch": {                                 // optional: start the app for this run, stop it afterwards
//     "command": "npm start", "cwd": "../my-app", "env": { "PORT": "{port}" },
//     "port": "auto",                           // a free port per run, so concurrent runs don't clash
//     "healthUrl": "{baseUrl}/health", "timeoutSeconds": 120
//   },
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
import { authFile } from './auth.mjs';
import { startProcess, stopProcess, waitForHttp } from './recorder.mjs';
import { runSteps } from './steps.mjs';
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
  if (!cfg.baseUrl) problems.push('baseUrl is required (or pass --base-url / set BASE_URL / choose an --env)');
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
      let proc, setupDone = false;
      const hookCtx = { dir, outDir: ctx.outDir, baseUrl: vars.baseUrl, log: ctx.log };
      try {
        if (cfg.launch?.command) {
          const logFile = path.join(ctx.outDir, 'app.log');
          proc = startProcess(cfg.launch.command, [], { shell: true, cwd: path.resolve(dir, cfg.launch.cwd ?? '.'), env: cfg.launch.env, logFile });
          await waitForHttp(cfg.launch.healthUrl ?? vars.baseUrl, { ms: (cfg.launch.timeoutSeconds ?? 120) * 1000, hint: `see ${logFile}` });
          ctx.log(`app up at ${vars.baseUrl}`);
        }
        await runHooks(cfg.hooks?.setup, hookCtx);
        setupDone = true;
        const state = cfg.login ? authFile(ctx.toolRoot, authTarget(cfg, ctx.options.env), ctx.options.role ?? cfg.login.role) : null;
        const haveState = state && fs.existsSync(state);
        if (cfg.login && !haveState && !cfg.login.steps?.length)
          throw new Error(`No saved login at ${state}; run: aft login <tour.json> --manual${ctx.options.env ? ` --env ${ctx.options.env}` : ''}`);
        const t = ctx.tour;
        await t.start({ storageState: haveState ? state : undefined });
        const opts = { baseUrl: vars.baseUrl + '/', timeouts: cfg.timeouts, report: ctx.report,
          onError: ctx.dryRun ? 'collect' : ctx.options.onError ?? cfg.onError ?? 'fail' };
        await t.page.goto(vars.baseUrl + '/', { timeout: cfg.timeouts?.navigation ?? 30000 });
        if (cfg.login && !haveState) {
          ctx.log('logging in (off camera)');
          await runSteps(t, cfg.login.steps, { ...opts, onError: 'fail', unpaced: true, scene: 'login' });
          fs.mkdirSync(path.dirname(state), { recursive: true });
          await t.context.storageState({ path: state });
          ctx.log(`saved login: ${state}`);
        }
        for (const [i, s] of cfg.scenes.entries()) {
          const id = ctx.scenes[i].id;
          if (s.url) await runSteps(t, [{ goto: s.url }], { ...opts, unpaced: true, scene: `${id} (url)` });
          await t.scene(id, () => runSteps(t, s.steps ?? [], { ...opts, scene: id }));
        }
        await t.finish({ baseUrl: vars.baseUrl });
      } finally {
        if (setupDone) await runHooks(cfg.hooks?.teardown, hookCtx).catch(e => ctx.log(`teardown failed: ${e.message}`));
        stopProcess(proc);
      }
    },
  };
}
