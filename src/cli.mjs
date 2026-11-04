#!/usr/bin/env node
// AutoFeatureTour CLI: story → script (editable tour.json) → validate → run (record) → post-process (narration,
// captions, video). Non-interactive unless you ask for it (login --manual, --headed).
//
//   aft generate --story <file|text> [--platform <name> | --base-url <url>] [--llm claude] [--style verification|demo|training] [--prompt ...]
//   aft validate <tour.json> | --script <tour.json>   dry run: checks every step resolves, nothing recorded
//   aft run      <tour.json|tour.mjs>                 record the video (render --record)
//   aft all      --story <file|text> --base-url <url> [--llm claude]   generate → validate → run, one run folder
//   aft render   <tour>  [--record]                   narration over clips/title cards, or a recording
//   aft discover <url>   [--max-pages 12]             crawl screens (used by generate/auto)
//   aft plan     <discovery.json|run folder> [--story ...] [--prompt ...] [--llm claude]
//   aft auto     <url> [--prompt ...]                 discover → plan → run, no story needed
//   aft login    --platform <name> | <tour.json> [--target <env>] [--role <name>] [--manual]   save auth/<platform>/<env>/<role>.json
//   aft platform list | init <name> [--base-url <url>] | discover <name> | check <name>   onboard an app (AGENTS.md, Platforms)
//   aft doctor   [--platform <name>]                  check this machine (+ platforms' requirements.mjs); exit 1 if missing
//   aft --list-voices | --help | --version
//
// Target selection: a tour names its platform (platforms/<name>/); --target <environment> (alias --env) and --role pick
// among the platform's; --base-url <url> or BASE_URL override the URL. --platform <name> for generate/discover/login. Other flags:
// --out <folder>, --name <run name>, --headed, --speech sapi|silent, --voice, --rate, --tail, --no-captions,
// --on-error fail|skip, --allow-draft (record a script that still has unresolved/empty scenes).
// Hand triage: --headed --pause (stop at the failure with the Playwright inspector), --until-step N / --from-step N
// (scene steps counted across the tour; steps before --from-step run fast and unpaced), --zip (triage.zip). Credentials: env vars or a .env file (never committed).
//
// Every command writes into its own run folder, out/<name>/<YYYYMMDD-HHMMSS>-<id>/ (story id in the name when there
// is one), never reused; out/<name>/latest.json and runs.jsonl are pointers only.
//
// Exit codes: 0 ok · 1 usage/config/unexpected error · 2 SCRIPT failure (an action step couldn't be done, or the
// script isn't ready: unresolved/empty scenes) · 3 the app wasn't reachable · 4 CRITERION failure (a verify step
// ran and its check failed) · 5 APP error (its error UI, an HTTP error or exception per the tour's "appErrors", or a
// page that never loaded, during a step) · 6 LOGIN failure · 7 TOOLING failure (ffmpeg, voice, browser, disk) ·
// 130 interrupted (Ctrl+C; the partial report and bundle are still written). A failed run writes no tour.mp4; it
// leaves report.json, report.md, triage/, screens/failure.png, trace-failed.zip and recording-failed.webm.
// --fresh-login: sign in again even if a saved session exists (expired sessions are renewed automatically anyway).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { saveLogin } from './auth.mjs';
import { composeTour, ConfigError, loadTourJson, readTourJson } from './declarative.mjs';
import { platformCommand } from './platform-cli.mjs';
import { loadPlatform } from './platform.mjs';
import { discover } from './discover.mjs';
import { doctor } from './doctor.mjs';
import { plan, readStory } from './plan.mjs';
import { Tour } from './recorder.mjs';
import { concat, cutClips, duration, muxScene, requireFfmpeg, writeCaptions } from './render.mjs';
import { parseScript, spokenText } from './script.mjs';
import { StepError, StopRun } from './steps.mjs';
import { CLASSES, classify, exitCode, Failure, summaryLine } from './failures.mjs';
import { finalize, progress } from './triage.mjs';
import { defaultProvider, estimateSeconds, listVoices, speak } from './tts.mjs';
import { log, newRunDir, num, parseArgs, run, sleep } from './util.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = new Set(['_', 'record', 'noRecord', 'out', 'clips', 'voice', 'rate', 'tail', 'noCaptions', 'listVoices', 'speech', 'name',
  'prompt', 'story', 'llm', 'model', 'maxScenes', 'maxPages', 'tour', 'include', 'exclude', 'manual', 'baseUrl', 'script', 'style',
  'headed', 'headless', 'target', 'help', 'version', 'allowDraft', 'zip', 'pause', 'fromStep', 'untilStep', 'platform', 'json']);
const safeName = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tour';

class UsageError extends Error {}
class UnreachableError extends Error {}

/** KEY=value lines from ./.env into process.env, without overriding variables that are already set. */
function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---- Run folders --------------------------------------------------------------------------------------------------

function startRun(name, args, command) {
  // Output lives under the tool's out/ (or AFT_OUT_DIR), whichever folder aft is run from.
  const base = path.join(path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out')), safeName(name));
  const dir = args.out ? newRunDir(path.resolve(args.out), { explicit: true }) : newRunDir(base);
  const info = { name: safeName(name), command, args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== '_')), input: args._.slice(1),
    dir, startedAt: new Date().toISOString(), status: 'running' };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(info, null, 2));
  log(`run folder: ${dir}`);
  return { dir, info, base };
}

function endRun(r, status, extra = {}) {
  Object.assign(r.info, { status, finishedAt: new Date().toISOString(), ...extra });
  fs.writeFileSync(path.join(r.dir, 'run.json'), JSON.stringify(r.info, null, 2));
  if (!r.dir.startsWith(r.base)) return; // --out elsewhere: no shared index
  // One short appended line per run; latest.json is written to a unique temp name and renamed over the old one.
  fs.appendFileSync(path.join(r.base, 'runs.jsonl'), JSON.stringify({ dir: path.basename(r.dir), command: r.info.command, status, at: r.info.finishedAt, ...extra }) + '\n');
  if (status === 'done') {
    const tmp = path.join(r.base, `.latest-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ dir: r.dir, command: r.info.command, at: r.info.finishedAt, ...extra }, null, 2));
    fs.renameSync(tmp, path.join(r.base, 'latest.json'));
  }
}

let currentRun = null;

async function withRun(name, args, command, fn) {
  const r = startRun(name, args, command);
  currentRun = r;
  try {
    endRun(r, 'done', (await fn(r.dir)) ?? {});
  } catch (e) {
    // Failures outside a recording (narration, ffmpeg, the disk, discovery, planning) still get a report and bundle.
    if (!fs.existsSync(path.join(r.dir, 'report.json')) || JSON.parse(fs.readFileSync(path.join(r.dir, 'report.json'), 'utf8')).result === 'RUNNING') {
      const report = await finalize({ outDir: r.dir, error: e, def: { name }, zip: !!args.zip }).catch(() => null);
      if (report && classify(e) !== 'error' && !(e instanceof UsageError) && !(e instanceof ConfigError)) printFailure(report, r.dir);
    }
    endRun(r, 'failed', { class: classify(e), exitCode: exitCode(e), error: e.message.split('\n')[0] });
    throw e;
  } finally {
    currentRun = null;
  }
}

/** Ctrl+C / kill: finalize the report and bundle (marked incomplete), record the run as interrupted, exit 130. */
let stopping = false;
async function onSignal(signal) {
  if (stopping) { console.error('\nforced exit'); process.exit(130); }
  stopping = true;
  console.error(`\n${signal}: stopping; writing the partial report and bundle (press Ctrl+C again to quit at once)`);
  const e = new Failure('interrupted', `interrupted by ${signal}`);
  const work = (async () => {
    if (active) {
      await active.tour.saveTrace('trace-failed.zip').catch(() => {});
      const report = await active.finalize(e, { complete: false }).catch(() => null);
      if (report) printFailure(report, active.outDir);
      await active.tour.close().catch(() => {});
    } else if (currentRun) await finalize({ outDir: currentRun.dir, error: e, complete: false }).catch(() => {});
    if (currentRun) endRun(currentRun, 'interrupted', { class: 'interrupted', exitCode: 130 });
  })();
  await Promise.race([work, sleep(15000)]);
  process.exit(130);
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
if (process.platform === 'win32') process.on('SIGBREAK', () => onSignal('SIGBREAK'));

// ---- Loading tours -----------------------------------------------------------------------------------------------

const envOf = args => args.target ?? args.env;

async function loadTour(file, args) {
  if (!file) throw new UsageError('Give a tour file (tour.json or .tour.mjs), or --script <file>');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new UsageError(`No such tour file: ${abs}`);
  if (abs.endsWith('.json')) return { def: loadTourJson(abs, { env: envOf(args), baseUrl: args.baseUrl, role: args.role, toolRoot }), dir: path.dirname(abs) };
  // A code tour (the whole-tour escape hatch). With "platform", ctx.platformDir is that platform's folder, and its
  // platform.json supplies pronounce/voice/viewport/mask defaults.
  const def = (await import(pathToFileURL(abs).href)).default;
  def.name ??= path.basename(abs).replace(/\.tour\.mjs$|\.mjs$/, '');
  if (def.platform) {
    let p;
    try { p = loadPlatform(toolRoot, def.platform, { from: path.dirname(abs) }); } catch (e) { throw new ConfigError(e.message); }
    def.platformDir = p.dir;
    def.pronounce = { ...p.platform.pronounce, ...def.pronounce };
    for (const k of ['voice', 'viewport', 'mask']) def[k] ??= p.platform[k];
  }
  return { def, dir: path.dirname(abs) };
}

const runName = (def, args) => args.name ?? (def.story?.id && !def.name.startsWith(def.story.id) ? `${def.story.id}-${def.name}` : def.name);

function scenesOf(def, tourDir) {
  return def.scenes
    ? def.scenes.map((s, i) => ({ number: i + 1, id: `scene-${String(i + 1).padStart(2, '0')}`, title: s.title, narration: s.narration, cues: [] }))
    : parseScript(path.resolve(tourDir, def.script));
}

function newTour(def, outDir, scenes, args, extra = {}) {
  return new Tour({ outDir, viewport: def.viewport, mask: def.mask, headless: !args.headed,
    narration: scenes.map(s => ({ id: s.id, seconds: s.seconds ?? estimateSeconds(s.narration) })), ...extra });
}

/** The run in progress, so a signal handler can still finalize its report and bundle. */
let active = null;

async function recordWith(def, tourDir, outDir, scenes, args, { dryRun = false } = {}) {
  if (!def.record) throw new UsageError(`${def.name} has no record(ctx); render it without --record to use clips or title cards`);
  const tour = newTour(def, outDir, scenes, args, { dryRun });
  const options = Object.fromEntries(Object.entries(args).filter(([k]) => !ENGINE.has(k)));
  if (envOf(args)) options.env = envOf(args);
  const range = args.fromStep || args.untilStep ? { n: 0, from: Number(args.fromStep ?? 0), until: Number(args.untilStep ?? 0) } : null;
  const secrets = [];
  const ctx = { tour, scenes, outDir, options, toolRoot, targetDir: tourDir, platformDir: def.platformDir ?? tourDir, log, run, dryRun, report: [], range, secrets };
  ctx.progress = () => { if (!dryRun) progress(outDir, def, ctx.report, secrets); };
  const started = Date.now();
  const done = async (error, extra = {}) => (dryRun ? null : finalize({ outDir, def, steps: ctx.report, tour, error, ms: Date.now() - started, zip: !!args.zip, secrets, ...extra }));
  active = { outDir, tour, finalize: (error, extra) => done(error, extra) };
  try {
    await def.record(ctx);
    await done(null);
  } catch (e0) {
    if (e0 instanceof StopRun) {
      log(`${e0.message}; browser state kept in the trace`);
      if (args.pause && tour.page) { log('paused: the Playwright inspector is open; resume or close it to finish'); await tour.page.pause().catch(() => {}); }
      await tour.saveTrace('trace.zip');
      await done(null, { warnings: [`partial run: ${e0.message}`] });
      return Object.assign(ctx.report, { partial: e0.message });
    }
    // Name the unreachable case plainly; keep the step it happened at.
    const net = e0.message.match(/net::(ERR_[A-Z_]+) at (\S+)/);
    const e = net && classify(e0) === 'unreachable' && !e0.failure
      ? new Failure('unreachable', `Can't reach ${net[2]} (${net[1]}). Is the app running there? Set the target with --base-url, BASE_URL or --target <environment>.`, { entry: e0.entry })
      : e0;
    if (args.pause && tour.page && !tour.page.isClosed()) {
      log('paused at the failure: the Playwright inspector is open; resume or close it to finish (needs --headed)');
      await tour.page.pause().catch(() => {});
    }
    if (tour.page && !tour.page.isClosed()) await tour.screenshot('failure');
    await tour.saveTrace('trace-failed.zip');
    const report = await done(e);
    if (report) printFailure(report, outDir);
    throw e;
  } finally {
    active = null;
    await tour.close();
    // A failed run leaves Playwright's partial video under a random name; give it a predictable one.
    for (const f of fs.readdirSync(outDir).filter(f => /^page@.*\.webm$/.test(f))) {
      try { fs.renameSync(path.join(outDir, f), path.join(outDir, 'recording-failed.webm')); } catch { /* still being written; keep its name */ }
    }
  }
  return ctx.report;
}

function printFailure(report, outDir) {
  const trace = ['trace-failed.zip', 'trace.zip'].map(f => path.join(outDir, f)).find(f => fs.existsSync(f));
  console.error([
    '',
    `${report.result}: ${report.error}`,
    report.firstCause ? `  first cause: ${report.firstCause.kind === 'network' ? `${report.firstCause.method} ${report.firstCause.request.replace(/\?.*$/, '')} ${report.firstCause.status ?? report.firstCause.failure}` : report.firstCause.text?.split('\n')[0]} (during ${report.firstCause.stepKey})` : null,
    `  bundle: ${report.bundleZip ?? report.bundle}`,
    `  read:   ${path.join(outDir, 'triage', 'report.md')}`,
    trace ? `  trace:  npx playwright show-trace "${trace}"` : '  trace:  (none: the tour sets "trace": false, or the browser never started)',
    `  replay: aft run <tour> --headed --pause${report.failing ? ` --until-step <n>` : ''}`,
    '',
  ].filter(Boolean).join('\n'));
}

// ---- Validate (dry run) ------------------------------------------------------------------------------------------

/** Problems visible in the script itself, reported as blocking validation items. */
function scriptIssues(raw) {
  const out = [];
  raw.scenes.forEach((s, i) => {
    const scene = `scene-${String(i + 1).padStart(2, '0')}`;
    for (const u of s.unresolved ?? []) out.push({ scene, step: '-', action: 'script', ok: false, error: `unresolved: ${u}` });
    if (s.todo) out.push({ scene, step: '-', action: 'script', ok: false, error: `to do: ${s.todo}` });
    if (!s.steps?.length && s.criteria?.length) out.push({ scene, step: '-', action: 'script', ok: false, error: `no steps, but it should demonstrate criteria ${s.criteria.join(', ')}` });
  });
  return out;
}

async function validate(def, tourDir, outDir, args) {
  if (def.scenes && !def.record) throw new UsageError('Nothing to validate');
  if (!def.raw) log('note: a .tour.mjs is code; validate runs it without recording but only reports errors it throws');
  const scenes = scenesOf(def, tourDir);
  // Script problems first: they need no app (scenes with nothing to do, steps the generator couldn't ground).
  const issues = def.raw ? scriptIssues(def.raw) : [];
  for (const i of issues) log(`script: ${i.scene}: ${i.error}`);
  const report = [...issues, ...(await recordWith(def, tourDir, outDir, scenes, args, { dryRun: true }))];
  const failed = report.filter(r => !r.ok);
  const blocking = failed.filter(r => !r.optional);
  const lines = [`# Validation: ${def.name}`, '', `${report.length} steps checked: ${report.length - failed.length} resolved, ${failed.length} failed` +
    ` (${blocking.length} blocking, ${failed.length - blocking.length} optional).`, '', '| | scene | step | action | target | result |', '|---|---|---|---|---|---|'];
  for (const r of report) {
    const target = r.spec ? JSON.stringify(r.spec[r.action]).slice(0, 60) : '';
    const result = r.ok ? 'ok' : `${r.error}${r.suggestions?.length ? `. Closest: ${r.suggestions.map(s => `"${s}"`).join(', ')}` : ''}`;
    lines.push(`| ${r.ok ? '✔' : r.optional ? '⚠' : '✘'} | ${r.scene} | ${r.step} | ${r.action} | \`${target.replace(/\|/g, '\\|')}\` | ${result.replace(/\|/g, '\\|')} |`);
  }
  fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify({ steps: report.length, failed: failed.length, blocking: blocking.length, report }, null, 2));
  fs.writeFileSync(path.join(outDir, 'validation.md'), lines.join('\n') + '\n');
  console.log(lines.slice(2).join('\n'));
  return { steps: report.length, failed: failed.length, blocking: blocking.length, report: path.join(outDir, 'validation.md') };
}

// ---- Render (narrate → record → cut → mux → join) ----------------------------------------------------------------

async function render(def, tourDir, outDir, args) {
  requireFfmpeg();
  const tail = args.tail !== undefined ? Number(args.tail) : 0.75;
  const provider = args.speech ?? (args.voice === 'silent' ? 'silent' : defaultProvider());
  const scenes = scenesOf(def, tourDir);
  fs.writeFileSync(path.join(outDir, 'script.md'), scenes.map(s => `## ${s.number}. ${s.title}\n\n${s.narration}\n`).join('\n'));

  for (const s of scenes) {
    s.wav = path.join(outDir, `${s.id}.wav`);
    await speak({ text: spokenText(s.narration, def.pronounce), wav: s.wav, voice: args.voice === 'silent' ? undefined : args.voice ?? def.voice,
      rate: Number(args.rate ?? 0), provider });
    s.narrationSeconds = await duration(s.wav);
    s.seconds = s.narrationSeconds + tail;
  }
  log(`narration (${provider}): ${scenes.length} scenes, ${num(scenes.reduce((a, s) => a + s.seconds, 0))} s`);

  const clipsDir = path.resolve(args.clips ?? (args.record ? path.join(outDir, 'clips') : path.join(tourDir, 'clips', def.name)));
  if (args.record) {
    const issues = def.raw && !args.allowDraft ? scriptIssues(def.raw) : [];
    if (issues.length)
      throw new StepError(`the script isn't ready to record (${issues.length} issue(s)):\n  ${issues.map(i => `${i.scene}: ${i.error}`).join('\n  ')}\nFix tour.json (aft validate shows them too), or pass --allow-draft to record anyway.`);
    const done = await recordWith(def, tourDir, outDir, scenes, args);
    if (done.partial) { log(`partial run (${done.partial}): report written, no video rendered`); return { partial: true }; }
    const timings = JSON.parse(fs.readFileSync(path.join(outDir, 'timings.json'), 'utf8')).scenes;
    await cutClips(path.join(outDir, 'recording.webm'), timings, clipsDir);
  }

  const segments = [];
  for (const s of scenes) {
    const seg = await muxScene({ scene: s, clip: path.join(clipsDir, `${s.id}.mp4`), outDir });
    segments.push(seg.file);
    s.length = seg.length;
  }
  const file = await concat(segments, outDir);
  if (!args.noCaptions)
    writeCaptions(scenes.map(s => ({ text: spokenText(s.narration), narrationSeconds: s.narrationSeconds, length: s.length })), path.join(outDir, 'tour.vtt'));
  const seconds = await duration(file);
  console.log(`Done: ${file}  (${num(seconds)} s)`);
  return { video: file, seconds: +num(seconds) };
}

// ---- Generate (story/prompt → editable tour.json + script.md) ----------------------------------------------------

/**
 * The app's settings without a tour to run: --platform <name> (its environment and role), or --tour <tour.json>
 * (a platform tour or a stand-alone one). null when neither is given.
 */
function appSettings(args) {
  if (!args.platform && !args.tour) return null;
  const file = args.tour ? path.resolve(args.tour) : path.join(toolRoot, '_platform.tour.json');
  const raw = args.tour ? readTourJson(file) : { name: args.platform, platform: args.platform, scenes: [] };
  if (args.platform && args.tour && raw.platform && raw.platform !== args.platform) throw new UsageError(`${args.tour} is a tour of ${raw.platform}, not ${args.platform}`);
  if (args.platform) raw.platform = args.platform;
  const c = composeTour(raw, { file, toolRoot, env: envOf(args), baseUrl: args.baseUrl, role: args.role });
  return { ...c, name: raw.platform ?? raw.name };
}

/** The app URL for generate/all: --base-url, BASE_URL, or the platform / --tour (its environment or baseUrl). */
function targetUrl(args) {
  if (args.baseUrl || process.env.BASE_URL) return args.baseUrl ?? process.env.BASE_URL;
  const app = appSettings(args);
  return app?.cfg.baseUrl ? new URL(app.cfg.startPath ?? '', app.cfg.baseUrl.replace(/\/?$/, '/')).href : undefined;
}

function loginStepsFor(args) {
  const app = appSettings(args);
  if (!app) return {};
  const { cfg } = app;
  const common = { ready: cfg.ready, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, paths: cfg.discover?.paths ?? [], errors: cfg.errors };
  if (!cfg.login) return common;
  const state = app.authFile(cfg.login.role);
  return fs.existsSync(state) ? { ...common, storageState: state } : { ...common, loginSteps: cfg.login.steps };
}

/** Discovers (when there's a URL), plans into out, and merges login/environments/hooks/mask from --tour. */
async function generateInto(out, args, { url, story, name }) {
  const discovery = url
    ? await discover({ url, outDir: out, maxPages: Number(args.maxPages ?? 12), include: args.include, exclude: args.exclude, ...loginStepsFor(args) })
    : null;
  const tour = await plan({ discovery, outDir: out, name: safeName(name), prompt: args.prompt, story, style: args.style, llm: args.llm, model: args.model,
    maxScenes: Number(args.maxScenes ?? 6), baseUrl: url ? undefined : args.baseUrl });
  const tourFile = path.join(out, 'tour.json');
  const app = appSettings(args);
  if (app?.platform) { // a platform tour names its platform and holds no app settings
    for (const k of ['baseUrl', 'environments', 'launch', 'login', 'ready', 'errors', 'mask', 'startPath', 'target']) delete tour[k];
    tour.platform = app.platform.name;
    if (envOf(args)) tour.env = envOf(args);
    if (args.role) tour.role = args.role;
    tour.needs = tour.needs?.filter(n => !n.startsWith('a target'));
    if (tour.needs && !tour.needs.length) { delete tour.needs; delete tour.draft; }
    fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2));
  } else if (args.tour) { // a stand-alone tour.json's own settings: login, environments, hooks, mask, timeouts
    const base = JSON.parse(fs.readFileSync(args.tour, 'utf8'));
    for (const k of ['login', 'environments', 'hooks', 'mask', 'timeouts', 'launch', 'viewport', 'voice', 'pronounce', 'ready', 'ignoreHTTPSErrors', 'startPath', 'baseUrl', 'errors'])
      if (base[k] !== undefined) tour[k] = base[k];
    if (tour.draft && tour.baseUrl) tour.needs = tour.needs?.filter(n => !n.startsWith('a target'));
    if (tour.needs && !tour.needs.length) { delete tour.needs; delete tour.draft; }
    tour.target = base.target ?? base.name;
    fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2));
  }
  log(`script: ${tour.scenes.length} scenes → ${tourFile} (narration for review: ${path.join(out, 'script.md')})`);
  if (tour.draft) log(`draft — before it can be recorded it needs:\n  - ${tour.needs?.join('\n  - ') ?? 'steps'}`);
  return { tour, tourFile, discovery };
}

const storyName = (story, url) => story?.id ? `${story.id}${url ? `-${new URL(url).hostname}` : ''}` : url ? new URL(url).hostname : 'story';

// ---- Commands ----------------------------------------------------------------------------------------------------

const commands = {
  async doctor(args) {
    if (!(await doctor({ toolRoot, platform: args.platform ?? args.target }))) process.exitCode = 1;
  },

  async generate(args) {
    const story = readStory(args.story);
    const url = targetUrl(args);
    if (!story && !args.prompt) throw new UsageError('Usage: aft generate --story <file|text> [--base-url <url>] [--llm claude] [--style ...]');
    await withRun(args.name ?? storyName(story, url), args, 'generate', async out => {
      const { tour, tourFile } = await generateInto(out, args, { url, story, name: args.name ?? storyName(story, url) });
      log(`next: review/edit it, then  aft validate "${tourFile}"  and  aft run "${tourFile}"`);
      return { tour: tourFile, scenes: tour.scenes.length, draft: !!tour.draft };
    });
  },

  async validate(args) {
    const { def, dir } = await loadTour(args.script ?? args._[1], args);
    let blocking = 0;
    await withRun(runName(def, args), args, 'validate', async out => {
      const r = await validate(def, dir, out, args);
      blocking = r.blocking;
      return r;
    });
    if (blocking) throw new StepError(`${blocking} step(s) can't be resolved; see validation.md in the run folder`);
  },

  async run(args) { return commands.render({ ...args, record: true }); },

  async render(args) {
    const { def, dir } = await loadTour(args.script ?? args._[1], args);
    await withRun(runName(def, args), args, args.record ? 'run' : 'render', out => render(def, dir, out, args));
  },

  async all(args) {
    const story = readStory(args.story);
    const url = targetUrl(args);
    if (!url) throw new UsageError('aft all needs the app: --base-url <url> (or BASE_URL). Example: aft all --story story.md --base-url https://qa.example.com/ --llm claude [--tour app.tour.json for login/hooks]');
    const name = args.name ?? storyName(story, url);
    let blocking = 0;
    await withRun(name, args, 'all', async out => {
      const { tour, tourFile } = await generateInto(out, args, { url, story, name });
      if (tour.draft) throw new StepError(`the generated script is a draft and wasn't recorded: edit ${tourFile}, then aft validate / aft run it`);
      const def = loadTourJson(tourFile, { env: envOf(args), baseUrl: args.baseUrl, role: args.role, toolRoot });
      const v = await validate(def, out, out, args);
      blocking = v.blocking;
      if (blocking) return { tour: tourFile, validation: v.report, blocking };
      // The dry run used its own browser session; the recording starts fresh.
      return { tour: tourFile, ...(await render(def, out, out, { ...args, record: true })) };
    });
    if (blocking) throw new StepError(`${blocking} step(s) can't be resolved; fix tour.json (see validation.md), then aft run it`);
  },

  async discover(args) {
    const url = args._[1] ?? args.baseUrl;
    if (!url) throw new UsageError('Usage: aft discover <url>');
    await withRun(args.name ?? new URL(url).hostname, args, 'discover', async out => {
      const d = await discover({ url, outDir: out, maxPages: Number(args.maxPages ?? 12), include: args.include, exclude: args.exclude, ...loginStepsFor(args) });
      return { pages: d.pages.length, discovery: path.join(out, 'discovery.json') };
    });
  },

  async plan(args) {
    let input = args._[1];
    if (!input) throw new UsageError('Usage: aft plan <discovery.json|run folder> [--prompt ...] [--story ...] [--llm claude]');
    if (fs.statSync(input).isDirectory()) input = path.join(input, 'discovery.json');
    const discovery = JSON.parse(fs.readFileSync(input, 'utf8'));
    const story = readStory(args.story);
    const name = args.name ?? (story?.id ?? new URL(discovery.origin).hostname);
    await withRun(name, args, 'plan', async out => {
      const tour = await plan({ discovery, outDir: out, name: safeName(name), prompt: args.prompt, story, style: args.style, llm: args.llm, model: args.model,
        maxScenes: Number(args.maxScenes ?? 6), baseUrl: args.baseUrl });
      return { tour: path.join(out, 'tour.json'), scenes: tour.scenes.length };
    });
  },

  async auto(args) {
    const url = args._[1] ?? args.baseUrl;
    if (!url) throw new UsageError('Usage: aft auto <url> [--prompt ...] [--llm claude] [--no-record]');
    const story = readStory(args.story);
    const name = args.name ?? storyName(story, url);
    await withRun(name, args, 'auto', async out => {
      const { tour, tourFile } = await generateInto(out, args, { url, story, name });
      if (tour.draft) throw new StepError(`the generated script is a draft and wasn't recorded: edit ${tourFile}, then aft validate / aft run it`);
      const def = loadTourJson(tourFile, { env: envOf(args), baseUrl: args.baseUrl, role: args.role, toolRoot });
      return { tour: tourFile, ...(await render(def, out, out, { ...args, record: !args.noRecord })) };
    });
  },

  async login(args) {
    const file = args.script ?? args._[1];
    if (!file && !args.platform) throw new UsageError('Usage: aft login --platform <name> [--target <env>] [--role <name>] [--manual]  (or aft login <tour.json>)');
    const app = appSettings({ ...args, tour: file });
    const { cfg } = app;
    if (!cfg.baseUrl) throw new UsageError(`${app.name}: no baseUrl for environment ${app.env ?? '(none)'}`);
    await saveLogin({ baseUrl: cfg.baseUrl, steps: cfg.login?.steps, file: app.authFile(cfg.login?.role), manual: !!args.manual, viewport: cfg.viewport,
      timeouts: cfg.timeouts, ready: cfg.ready, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, signedIn: cfg.login?.signedIn });
  },

  async platform(args) {
    return platformCommand(args, { toolRoot, commands, appSettings, loginStepsFor, withRun, UsageError, envOf });
  },

};

/** The comment block at the top of this file is the help text, so the two can't drift apart. */
function helpText() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
  return lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.listVoices) { console.log((await listVoices()).join('\n')); return; }
  if (args.version) { console.log(JSON.parse(fs.readFileSync(path.join(toolRoot, 'package.json'), 'utf8')).version); return; }
  const cmd = args._[0];
  if (args.help || cmd === 'help' || !cmd) { console.log(helpText()); return; }
  if (!cmd) throw new UsageError('Usage: aft generate|validate|run|all|render|discover|plan|auto|login ... (see src/cli.mjs or the README)');
  if (commands[cmd]) return commands[cmd](args);
  if (/\.(mjs|json)$/.test(cmd)) return commands.render({ ...args, _: ['render', ...args._] });
  throw new UsageError(`Unknown command "${cmd}"`);
}

main().catch(e => {
  // Exit codes come from one table (src/failures.mjs); usage/config errors and drafts are classified here.
  const cls = e instanceof UsageError || e instanceof ConfigError ? 'error' : e.failure ?? (e instanceof StepError ? 'script' : e instanceof UnreachableError ? 'unreachable' : classify(e));
  const code = CLASSES[cls]?.exit ?? 1;
  if (cls === 'error' && !(e instanceof UsageError) && !(e instanceof ConfigError)) console.error(e.stack ?? e);
  else console.error(`error: ${summaryLine(Object.assign(e, { failure: e.failure ?? cls }))}`);
  process.exit(code);
});
