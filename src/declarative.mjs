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
import { assertValid } from './schema.mjs';
import { checkTour, expandSceneSteps, expandSteps, fixtureItems, loadFixtures, loadMocks, loadPlatform, PlatformError, platformAuthFile, platformConfig } from './platform.mjs';
import { Workarounds, workaroundProblems } from './workarounds.mjs';
import { probe, startProcess, stopProcess, waitForHttp } from './recorder.mjs';
import { Failure } from './failures.mjs';
import { fillArtifacts, runSteps, settle, StopRun } from './steps.mjs';
import { freePort } from './util.mjs';

/** Opens a sign-in check page; a load timeout is an APP failure (as for a goto step), not a tool error. */
async function openCheckPage(page, url, timeout, where) {
  try { await page.goto(url, { timeout }); }
  catch (e) {
    if (/Timeout/i.test(e.message)) throw new Failure('app', `the app showed an error: page didn't load within ${timeout / 1000}s (${url}), ${where}`);
    throw e;
  }
}
import { earlierOpen, finishUndo, Ledger, recordArtifact, runHooks, setupBrowser, setupItems, sharedWarnings, undoInBrowser, writeArtifacts } from './fixtures.mjs';
import { runTag, undoAll } from './ledger.mjs';

export { runHooks };

/** A problem with the tour file itself; the CLI prints it without a stack trace (exit 1). */
export class ConfigError extends Error {}

/** Replaces {env:NAME} and {key} placeholders in every string of a JSON value. */
function fill(value, vars) {
  if (typeof value === 'string')
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => process.env[k] ?? '')
      .replace(/\{run\.tag\}/g, m => vars.runTag ?? m)
      .replace(/\{([A-Za-z]+)\}/g, (m, k) => (k in vars && k !== 'runTag' ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map(v => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

export function validate(cfg, file) {
  const problems = [];
  if (!cfg.baseUrl) problems.push('no target: name a "platform" (its environments.json has the baseUrl), or pass --base-url <url> / set BASE_URL');
  if (!Array.isArray(cfg.scenes) || !cfg.scenes.length) problems.push('scenes must be a non-empty array');
  (cfg.scenes ?? []).forEach((s, i) => {
    if (!s.title) problems.push(`scenes[${i}].title is required`);
    if (!s.narration && s.camera !== false) problems.push(`scenes[${i}].narration is required (or "camera": false: an off-camera scene)`);
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

/**
 * A tour as the run needs it. With "platform": the platform's settings, environment, login role and fixtures,
 * fragments expanded, BASE_URL / --base-url on top. Without: the tour's own settings (a stand-alone tour, for quick
 * experiments and tests). Returns { cfg, env, platform, authFile(role) }.
 */
export function composeTour(raw, { file, toolRoot, env, baseUrl, role } = {}) {
  const dir = path.dirname(path.resolve(file));
  const wrap = fn => { try { return fn(); } catch (e) { throw e instanceof PlatformError ? new ConfigError(e.message) : e; } };
  if (!raw.platform) {
    const cfg = resolveConfig(raw, { env, baseUrl });
    const dirs = [path.join(dir, 'fragments'), dir];
    wrap(() => {
      cfg.scenes = (cfg.scenes ?? []).map(s => ({ ...s, steps: expandSceneSteps(s.steps, { dirs }) }));
      if (cfg.login?.steps) cfg.login = { ...cfg.login, steps: expandSteps(cfg.login.steps, { dirs }) };
    });
    wrap(() => finishSteps(cfg, file, [dir]));
    const problems = workaroundProblems(cfg.workarounds);
    if (problems.length) throw new ConfigError(`${file}:\n  ${problems.join('\n  ')}`);
    return { cfg, env, platform: null, authFile: r => authFile(toolRoot, authTarget(cfg, env), r ?? cfg.login?.role) };
  }
  return wrap(() => {
    checkTour(raw, file);
    const p = loadPlatform(toolRoot, raw.platform, { from: dir });
    const { cfg: base, env: envName } = platformConfig(p, { env: env ?? raw.env, role: role ?? raw.role, platformRulesOnly: !!(baseUrl || process.env.BASE_URL) });
    const fx = loadFixtures(p, raw.fixtures);
    // Data, most specific last: the platform's, the environment's, then the tour's fixtures.
    const data = { ...base.data, ...fx.data };
    const dirs = [path.join(p.dir, 'fragments'), dir];
    // Each fixture's browser steps: checks (already in place?), the steps, and the cleanup that undoes them.
    const browser = fx.browser.map(b => ({ ...b, steps: expandSteps(b.steps, { dirs, data }), checkSteps: expandSteps(b.checkSteps, { dirs, data }), cleanupSteps: expandSteps(b.cleanupSteps, { dirs, data }) }));
    const mocks = loadMocks(p, raw.mocks);
    const cfg = {
      ...base, ...raw,
      timeouts: { ...base.timeouts, ...raw.timeouts },
      pronounce: { ...base.pronounce, ...raw.pronounce },
      hooks: { setup: [...fx.setup, ...(raw.hooks?.setup ?? [])], teardown: [...(raw.hooks?.teardown ?? []), ...fx.teardown] },
      // Paired setup/teardown items: the fixtures', then the tour's own hooks.
      fixtureItems: [...fx.items, ...fixtureItems({ setup: raw.hooks?.setup, teardown: raw.hooks?.teardown }, 'tour')],
      // Mock sets first (they must be in place before anything loads), then the fixtures' own steps.
      fixtureMocks: mocks,
      fixtureBrowser: browser,
      fixtureSteps: [...mocks, ...browser.flatMap(b => [...b.checkSteps, ...b.steps, ...b.cleanupSteps])],
      data,
      scenes: (raw.scenes ?? []).map(s => ({ ...s, steps: expandSceneSteps(s.steps, { dirs, data }) })),
      ...(base.login ? { login: { ...base.login, steps: expandSteps(base.login.steps, { dirs, data }) } } : {}),
      ...(base.loginRoles ? { loginRoles: Object.fromEntries(Object.entries(base.loginRoles).map(([n, l]) => [n, { ...l, steps: expandSteps(l.steps, { dirs, data }) }])) } : {}),
    };
    // A signInAs step names a role of the platform's login.json.
    for (const s of allSteps(cfg)) if (s.signInAs && !cfg.loginRoles?.[s.signInAs])
      throw new ConfigError(`${file}: { "signInAs": "${s.signInAs}" }: platform ${p.name} has no login role "${s.signInAs}" (has: ${Object.keys(cfg.loginRoles ?? {}).join(', ') || 'none'})`);
    // Known issues: the platform's and environment's, then the story's own (same name refines one; source "story").
    cfg.workarounds = storyWorkarounds(base.workarounds, raw.workarounds);
    const problems = workaroundProblems(cfg.workarounds);
    if (problems.length) throw new ConfigError(`${file}:\n  ${problems.join('\n  ')}`);
    if (!cfg.workarounds.length) delete cfg.workarounds;
    if (process.env.BASE_URL) cfg.baseUrl = process.env.BASE_URL;
    if (baseUrl) cfg.baseUrl = baseUrl;
    finishSteps(cfg, file, [dir, path.join(p.dir, 'fixtures')]);
    return { cfg, env: envName, platform: p, authFile: r => platformAuthFile(toolRoot, p.name, envName, r ?? cfg.login?.role) };
  });
}

/** The story's workarounds over the platform's (by name, like an environment's; "off": true turns one off for it). */
function storyWorkarounds(base = [], story = []) {
  const out = [...base];
  for (const r of story) {
    const i = out.findIndex(x => x.name === r.name);
    if (i >= 0) out[i] = { ...out[i], ...r, source: 'story' }; else out.push({ ...r, source: 'story' });
  }
  return out.filter(r => !r.off);
}

export function readTourJson(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(`${file}: not valid JSON (${e.message})`); }
  assertValid('tour', raw, file, ConfigError);
  delete raw.$schema;
  raw.name ??= path.basename(file).replace(/\.tour\.json$|\.json$/, '');
  return raw;
}

/** Steps of every list in a composed tour (login, fixtures, scenes). */
const allSteps = cfg => [...(cfg.login?.steps ?? []), ...(cfg.fixtureSteps ?? []), ...(cfg.scenes ?? []).flatMap(s => s.steps ?? [])];

/** Checks that need the whole tour: mocks are opted into, upload files exist (made absolute). */
function finishSteps(cfg, file, dirs) {
  const mocks = allSteps(cfg).filter(s => 'mock' in s);
  if (mocks.length && !cfg.allowMocks) throw new ConfigError(`${file}: ${mocks.length} "mock" step(s), but the tour doesn't set "allowMocks": true (mocked responses make the run not end to end; opt in deliberately)`);
  // A verification video is evidence that the app works end to end: canned responses would make it say otherwise.
  if (mocks.length && cfg.style === 'verification') throw new ConfigError(`${file}: "style": "verification" can't use "mock" steps (${mocks.length}): a verification must be end to end. Use "demo" or "training", or remove the mocks`);
  for (const s of allSteps(cfg).filter(s => 'upload' in s)) {
    s.files = [s.files].flat().map(f => {
      if (path.isAbsolute(f) && fs.existsSync(f)) return f;
      const hit = dirs.map(d => path.resolve(d, f)).find(x => fs.existsSync(x));
      if (!hit) throw new ConfigError(`${file}: upload file "${f}" not found (looked in ${dirs.join(', ')})`);
      return hit;
    });
  }
  return cfg;
}

/** Loads tour.json as a tour definition the CLI can run, like a .tour.mjs module. */
export function loadTourJson(file, { env, baseUrl, role, toolRoot } = {}) {
  const raw = readTourJson(file);
  const composed = composeTour(raw, { file, toolRoot, env, baseUrl, role });
  const cfg0 = composed.cfg;
  validate(cfg0, file);
  const dir = path.dirname(path.resolve(file));
  return {
    name: raw.name,
    platform: composed.platform?.name,
    env: composed.env,
    story: raw.story,
    raw: cfg0,
    voice: cfg0.voice,
    pronounce: cfg0.pronounce,
    viewport: cfg0.viewport,
    mask: cfg0.mask,
    video: cfg0.video,
    scenes: raw.scenes.map((s, i) => ({ number: i + 1, title: s.title, narration: s.narration ?? '', offCamera: s.camera === false })),
    /** Warnings about the tour as written (data left untagged on a shared environment). */
    warnings: sharedWarnings(cfg0),
    /** The saved login of a role in the tour's environment (a stage hands off as another role). */
    authFile: role => composed.authFile(role),
    platformFolder: composed.platform?.dir ?? null,
    tourFile: path.resolve(file),
    async record(ctx) {
      // A stage (src/stage.mjs): stop at a point, keep the browser, services and data until `aft stage end`.
      const stage = ctx.stage ?? null;
      const tag = runTag(ctx.outDir);
      const { cfg, vars } = await materialize(cfg0, { tag });
      // Values marked secret (resolved from the environment) are scrubbed from every report and bundle file.
      ctx.secrets?.push(...secretsOf(cfg));
      const log = ctx.log;
      const t = ctx.tour;
      t.artifacts = [];
      t.secrets = ctx.secrets;
      let services = { procs: [] };
      // Everything set up is written to ledger.json before it runs, so a crash leaves a record for `aft cleanup`.
      const ledger = new Ledger(path.join(ctx.outDir, 'ledger.json'), { tour: raw.name, tourFile: path.resolve(file), tourDir: dir, platform: composed.platform?.name ?? null,
        env: composed.env ?? null, role: cfg.login?.role ?? null, baseUrl: vars.baseUrl, tag, ...(ctx.dryRun ? { dryRun: true } : {}), ...(stage ? { stage: { live: true } } : {}) });
      ctx.ledger = ledger;
      const onPin = a => {
        a.scriptStep = t.stepScript ?? null;
        t.artifacts = [...t.artifacts.filter(x => x.name !== a.name), a];
        recordArtifact(ledger, a);
        writeArtifacts(ctx.outDir, t.artifacts, ledger);
      };
      t.onPin = onPin;
      const hookCtx = { dir, outDir: ctx.outDir, baseUrl: vars.baseUrl, log, tag, onPin: a => { t.secrets?.push(...(a.secret ?? []).map(k => a.fields[k]).filter(Boolean)); onPin(a); } };
      const undoHooks = hooks => runHooks(fillArtifacts(hooks, t.artifacts), hookCtx);
      let opts = null;
      let browserUp = false;
      // Ctrl+C: undo what is pending (with a time limit), browser steps too while the browser is up.
      ctx.undo = async ({ deadline } = {}) => {
        if (browserUp && opts) await undoInBrowser(t, ledger, { opts, log, deadline }).catch(e => log(`cleanup failed: ${e.message}`));
        await undoAll(ledger, { undoHooks, log, deadline });
        ctx.fixtures = ledger.summary();
        ctx.artifacts = writeArtifacts(ctx.outDir, t.artifacts, ledger);
      };
      try {
        services = await startServices(cfg, vars, { outDir: ctx.outDir, log, dir });
        // An earlier run of this tour that crashed or was interrupted: finish its undo first, so this run starts clean.
        // Never for a stage: that data may be the stage it replaces, which `--redo` ends explicitly.
        const earlier = ctx.options?.out || stage ? [] : earlierOpen(ctx.outDir, ledger.doc);
        if (earlier.length) { log(`${earlier.length} earlier run(s) of this tour left data behind: undoing it first`); await finishUndo(earlier, { log }); }
        const items = cfg.fixtureItems ?? fixtureItems({ setup: cfg.hooks?.setup, teardown: cfg.hooks?.teardown }, 'tour');
        const looked = await setupItems(items, { ledger, hookCtx, artifacts: () => t.artifacts, log });
        const login = makeLogin(cfg, cfg0, composed, { outDir: ctx.outDir, log, options: ctx.options, baseUrl: vars.baseUrl });
        await login.beforeStart();
        // Roles the tour switches to (signInAs): signed in now, off camera, so each switch only loads a saved login.
        t.signInAs = await accountSwitcher(cfg, cfg0, composed, { outDir: ctx.outDir, log, options: ctx.options, baseUrl: vars.baseUrl, main: login });
        if (t.signInAs) t.account = cfg.login?.role;
        t.policy = cfg.appErrors ?? {};
        // Data for {data.x} left in steps until now: fixture data, plus what setup hooks looked up.
        t.data = { ...cfg.data, ...looked };
        if (cfg.workarounds?.length) t.workarounds = new Workarounds(cfg.workarounds, { baseUrl: vars.baseUrl + '/', timeouts: cfg.timeouts, ready: cfg.ready, log });
        const startOpts = { storageState: login.state ?? undefined, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, trace: cfg.trace !== false && !(stage && !stage.trace) };
        await t.start(startOpts);
        browserUp = true;
        opts = { baseUrl: vars.baseUrl + '/', timeouts: cfg.timeouts, report: ctx.report, ready: cfg.ready, errors: cfg.errors, retries: cfg.retries ?? 1,
          allowMocks: !!cfg.allowMocks, outDir: ctx.outDir,
          range: ctx.range,
          onError: stage ? 'fail' : ctx.dryRun ? 'collect' : ctx.options.onError ?? cfg.onError ?? 'fail' };
        ctx.live = { cfg, vars, services, opts, startOpts, ledger };
        // Check the session where the tour starts (off camera: before the first scene, so it's cut from the video).
        await login.ensure(t, startOpts, cfg.scenes[0]?.url);
        try {
          // Browser undo an earlier run left pending, in this browser.
          if (earlier.some(f => f.ledger.pending({ retryFailed: true }).some(i => i.undo.steps)))
            await finishUndo(earlier, { log, hooks: false, openBrowser: async () => ({ undoSteps: steps => runSteps(t, steps, { ...opts, unpaced: true, scene: 'cleanup (earlier run)', report: null, onError: 'fail' }) }) });
          // Fixture steps: data the tour needs, put in place through the browser, off camera. Mock sets first.
          const mocks = cfg.fixtureMocks ?? cfg.fixtureSteps ?? [];
          if (mocks.length) await runSteps(t, mocks, { ...opts, unpaced: true, scene: 'fixtures' });
          await setupBrowser(t, cfg.fixtureBrowser ?? [], { ledger, opts, log });
          for (const [i, s] of cfg.scenes.entries()) {
            const id = ctx.scenes[i].id;
            // A stage's stop point by scene: range.scenes = n runs the first n scenes (0: setup only).
            if (ctx.range?.scenes !== undefined && i >= ctx.range.scenes)
              throw new StopRun(ctx.range.scenes ? `stopped after scene ${ctx.range.scenes}` : 'stopped after setup');
            // range.step with range.scenes = n: scene n only up to that step of the script (fragments count as one).
            const cut = ctx.range?.step && ctx.range.scenes === i + 1;
            const steps = cut ? (s.steps ?? []).filter((x, k) => (x.scriptStep ?? k + 1) <= ctx.range.step) : s.steps ?? [];
            if (s.url) await runSteps(t, [{ goto: s.url }], { ...opts, unpaced: true, scene: `${id} (url)` });
            // Off camera: it runs and is checked like any scene, but it isn't filmed or narrated.
            if (s.camera === false) {
              await runSteps(t, steps, { ...opts, offCamera: true, scene: id, criteria: s.criteria ?? [] });
              await t.screenshot(id);
            } else await t.scene(id, () => runSteps(t, steps, { ...opts, scene: id, criteria: s.criteria ?? [] }));
            ctx.progress?.();
            if (cut) throw new StopRun(`stopped after scene ${i + 1} · step ${ctx.range.step}`);
          }
        } finally {
          // Browser cleanup (artifacts' cleanup steps, fixtures' cleanupSteps), off camera; also after a failed scene.
          if (!stage) await undoInBrowser(t, ledger, { opts, log }).catch(e => log(`cleanup failed: ${e.message.split('\n')[0]}`));
        }
        if (!stage) await t.finish({ baseUrl: vars.baseUrl }); // a stage keeps its page open for the hand-off
      } finally {
        if (stage) ctx.live = { ...ctx.live, services, ledger }; // a stage: nothing undone or stopped yet (ctx.undo, at `stage end`)
        else {
          // Hook undo, newest first, only what ran. Browser steps left pending (the browser was gone) wait for aft cleanup.
          const r = await undoAll(ledger, { undoHooks, log }).catch(e => { log(`teardown failed: ${e.message}`); return null; });
          if (r?.failed) log(`${r.failed} undo step(s) failed: data left behind (see ledger.json; aft cleanup ${ctx.outDir})`);
          for (const p of services.procs) stopProcess(p);
        }
        ctx.fixtures = ledger.summary();
        ctx.artifacts = writeArtifacts(ctx.outDir, t.artifacts, ledger);
      }
    },
  };
}

// ---- Pieces of a run, shared with sessions (src/session.mjs) -----------------------------------------------------

/** Picks a free port when the launch asks for one and fills {port} / {baseUrl} / {env:NAME} everywhere. */
export async function materialize(cfg0, { tag } = {}) {
  const first = [cfg0.launch ?? []].flat()[0];
  const port = first?.port === 'auto' ? await freePort() : first?.port;
  const vars = { port: port ?? '', ...(tag ? { runTag: tag } : {}) };
  vars.baseUrl = fill(cfg0.baseUrl, vars).replace(/\/$/, '');
  return { cfg: fill(cfg0, vars), vars };
}

export const secretsOf = cfg => [...(cfg.login?.steps ?? []), ...(cfg.scenes ?? []).flatMap(s => s.steps ?? [])].filter(s => s.secret && s.text).map(s => s.text);

/**
 * attach: environments a run never starts (down = UNREACHABLE). launch: used as is when already answering (never
 * stopped), else started and waited for. Returns { procs } to stop (those started without "stop": false) and
 * "services": what was found or started, for session status.
 */
export async function startServices(cfg, vars, { outDir, log, dir }) {
  const procs = [], services = [];
  for (const a of [cfg.attach ?? []].flat()) {
    const health = a.healthUrl ?? vars.baseUrl;
    if (!(await probe(health, { any: a.anyStatus }))) throw new Failure('unreachable', `${a.name ?? 'app'} isn't running at ${health}; this environment is attach-only, so start it yourself`);
    log(`${a.name ?? 'app'}: running at ${health}`);
    services.push({ name: a.name ?? 'app', health, started: false });
  }
  for (const [n, l] of [cfg.launch ?? []].flat().entries()) {
    const health = l.healthUrl ?? vars.baseUrl;
    const label = l.name ?? (n ? `service ${n + 1}` : 'app');
    if (await probe(health, { any: l.anyStatus })) {
      log(`${label}: already running at ${health}; using it (it won't be stopped)`);
      services.push({ name: label, health, started: false });
      continue;
    }
    if (!l.command) throw new Error(`${label} didn't come up: nothing answers at ${health} and the tour has no launch command for it`);
    const logFile = path.join(outDir, `${label.replace(/[^A-Za-z0-9_-]+/g, '-')}.log`);
    log(`${label}: starting (${l.command}); log: ${logFile}`);
    const proc = startProcess(l.command, [], { shell: true, cwd: path.resolve(dir, l.cwd ?? '.'), env: l.env, logFile });
    if (l.stop !== false) procs.push(proc);
    await waitForHttp(health, { ms: (l.timeoutSeconds ?? 120) * 1000, any: l.anyStatus, hint: `see ${logFile}`, proc, logFile, label });
    log(`${label}: up at ${health}${l.stop === false ? ' (left running afterwards)' : ''}`);
    services.push({ name: label, health, started: true, pid: proc.pid, stops: l.stop !== false, log: logFile });
  }
  return { procs, services };
}

/**
 * What login steps need and don't have: an {env:NAME} that is empty, a {data.x} that no platform, environment or
 * fixture data provides. Each as a hint for the person fixing it.
 */
export function missingCredentials(steps = []) {
  const json = JSON.stringify(steps);
  return [...new Set([
    ...[...json.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1]).filter(k => !process.env[k]).map(k => `set ${k} (environment or .env)`),
    ...[...json.matchAll(/\{data\.([A-Za-z0-9_.-]+)\}/g)].map(m => `data.${m[1]} (add it to "data" in platform.json, the environment, or a fixture)`),
  ])];
}

/**
 * { "signInAs": "<role>" }: switches the run's browser to another login role partway through, without a new context
 * (the video carries on). Every role the tour switches to is signed in before the browser starts (a separate browser,
 * saved as auth/<platform>/<env>/<role>.json, as for the run's own role). A switch clears the cookies (except those
 * whose domain contains one of "keepCookies") and the open page's storage, loads the role's saved cookies and local
 * storage, opens its checkPath and waits for login.signedIn; an expired saved login is renewed once, off camera.
 * Returns undefined when the tour has no signInAs step.
 */
export async function accountSwitcher(cfg, cfg0, composed, { outDir, log, options, baseUrl, main }) {
  const wanted = [...new Set(allSteps(cfg).filter(s => s.signInAs).map(s => s.signInAs))];
  if (!wanted.length) return undefined;
  const roles = cfg.loginRoles ?? (cfg.login ? { [cfg.login.role]: cfg.login } : {});
  const roles0 = cfg0.loginRoles ?? (cfg0.login ? { [cfg0.login.role]: cfg0.login } : {});
  const logins = {};
  for (const r of wanted) {
    if (!roles[r]) throw new ConfigError(`{ "signInAs": "${r}" }: no login role "${r}" (has: ${Object.keys(roles).join(', ') || 'none'})`);
    logins[r] = r === cfg.login?.role ? main : makeLogin({ ...cfg, login: roles[r] }, { ...cfg0, login: roles0[r] }, composed, { outDir, log, options, baseUrl });
    if (r !== cfg.login?.role) await logins[r].beforeStart();
  }
  let gen = 0;
  const apply = async (t, file, keep) => {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const context = t.page.context();
    const kept = keep.length ? (await context.cookies()).filter(c => keep.some(k => c.domain.includes(k))) : [];
    await context.clearCookies();
    await context.addCookies([...kept, ...(state.cookies ?? []).filter(c => !kept.some(k => k.name === c.name && k.domain === c.domain && k.path === c.path))]);
    await t.page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* opaque origin */ } }).catch(() => {});
    // Local storage per origin, applied on the next load of that origin (once per switch: a newer switch wins).
    const g = ++gen;
    for (const o of state.origins ?? []) {
      await context.addInitScript(({ origin, items, g }) => {
        if (location.origin !== origin || Number(sessionStorage.getItem('aft-signin') ?? 0) >= g) return;
        localStorage.clear();
        for (const { name, value } of items) localStorage.setItem(name, value);
        sessionStorage.setItem('aft-signin', String(g));
      }, { origin: o.origin, items: o.localStorage ?? [], g });
    }
  };
  return async (t, step, { timeouts = {} } = {}) => {
    const role = step.signInAs, login = roles[role];
    const keep = [step.keepCookies ?? []].flat();
    const startAt = baseUrl + '/' + String(step.url ?? login.checkPath ?? cfg.startPath ?? '').replace(/^\//, '');
    const signedIn = async () => {
      await openCheckPage(t.page, startAt, timeouts.navigation ?? 30000, `checking the sign-in for signInAs ${role}`);
      await settle(t.page, cfg.ready);
      return !login.signedIn || t.page.locator(login.signedIn).first().waitFor({ timeout: timeouts.waitFor ?? 15000 }).then(() => true, () => false);
    };
    const file = composed.authFile(role);
    if (!fs.existsSync(file)) await logins[role].renew('no saved login');
    await apply(t, file, keep);
    if (!(await signedIn())) {
      await logins[role].renew('saved login expired');
      await apply(t, file, keep);
      if (!(await signedIn())) throw new Failure('login', `signInAs ${role}: signed in, but ${login.signedIn} isn't on ${t.page.url()}: check the role's signedIn / checkPath`);
    }
    t.account = role;
    log(`signed in as ${role}`);
  };
}

/**
 * Saved login for the run's role: beforeStart() signs in (off camera, separate browser) when there's no saved state,
 * it's too old or --fresh-login; ensure(t) opens the check page and, if the session has expired, signs in again and
 * restarts the browser context.
 */
export function makeLogin(cfg, cfg0, composed, { outDir, log, options = {}, baseUrl }) {
  const state = cfg.login ? composed.authFile(cfg.login.role) : null;
  const missingCreds = missingCredentials(cfg0.login?.steps);
  const canLogin = !!cfg.login?.steps?.length && !missingCreds.length;
  const cannot = () => (!cfg.login?.steps?.length ? `there are no login steps: run aft login --platform <name> --manual (or aft login <tour.json> --manual)${options.env ? ` --target ${options.env}` : ''}`
    : `credentials missing: ${missingCreds.join(', ')}`);
  let fresh = false;
  const signIn = async why => {
    if (!canLogin) throw new Failure('login', `${why}, and the tour can't sign in by itself: ${cannot()}`);
    // In a separate browser that is neither recorded nor traced, so credentials never reach the run's files.
    log(`${why}: signing in (separate browser, not recorded)`);
    await saveLogin({ baseUrl: baseUrl + '/', steps: cfg.login.steps, file: state, viewport: cfg.viewport, timeouts: cfg.timeouts, ready: cfg.ready, workarounds: cfg.workarounds,
      ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, failureShot: path.join(outDir, 'login-failure.png'), signedIn: cfg.login.signedIn });
    fresh = true;
  };
  return {
    state,
    get fresh() { return fresh; },
    /** Signs in again now (separate browser), e.g. for a signInAs switch whose saved login expired. */
    renew: why => signIn(why),
    async beforeStart() {
      if (!cfg.login) return;
      const age = fs.existsSync(state) ? (Date.now() - fs.statSync(state).mtimeMs) / 60000 : null;
      const why = age === null ? 'no saved login' : options.freshLogin ? '--fresh-login' : cfg.login.maxAgeMinutes && age > cfg.login.maxAgeMinutes ? `saved login is ${Math.round(age)} min old (maxAgeMinutes ${cfg.login.maxAgeMinutes})` : null;
      if (why) await signIn(why);
    },
    async ensure(t, startOpts, firstUrl) {
      const startAt = baseUrl + '/' + String(cfg.login?.checkPath ?? cfg.startPath ?? firstUrl ?? '').replace(/^\//, '');
      const signedIn = async () => {
        await openCheckPage(t.page, startAt, cfg.timeouts?.navigation ?? 30000, 'checking the sign-in before the first scene');
        await settle(t.page, cfg.ready);
        if (!cfg.login?.signedIn) return true;
        return t.page.locator(cfg.login.signedIn).first().waitFor({ timeout: fresh ? cfg.ready?.timeout ?? 30000 : cfg.timeouts?.waitFor ?? 15000 }).then(() => true, () => false);
      };
      if (await signedIn()) return;
      if (fresh) throw new Failure('login', `signed in, but ${cfg.login.signedIn} isn't on ${t.page.url()}: check login.signedIn / login.checkPath`);
      await signIn('saved login expired');
      await t.restart(startOpts); // a fresh context with the new session; nothing has been filmed yet
      if (!(await signedIn())) throw new Failure('login', `signed in again, but ${cfg.login.signedIn} isn't on ${t.page.url()}: check login.signedIn / login.checkPath`);
      log('saved login expired; signed in again');
    },
  };
}
