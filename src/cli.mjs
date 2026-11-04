#!/usr/bin/env node
// AutoFeatureTour CLI: story → script (editable tour.json) → validate → run (record) → post-process (narration,
// captions, video). Non-interactive unless you ask for it (login --manual, --headed).
//
//   aft generate --story <file|text> [--base-url <url>] [--llm claude] [--style verification|demo|training] [--prompt ...]
//   aft validate <tour.json> | --script <tour.json>   dry run: checks every step resolves, nothing recorded
//   aft run      <tour.json|tour.mjs>                 record the video (render --record)
//   aft all      --story <file|text> --base-url <url> [--llm claude]   generate → validate → run, one run folder
//   aft render   <tour>  [--record]                   narration over clips/title cards, or a recording
//   aft discover <url>   [--max-pages 12]             crawl screens (used by generate/auto)
//   aft plan     <discovery.json|run folder> [--story ...] [--prompt ...] [--llm claude]
//   aft auto     <url> [--prompt ...]                 discover → plan → run, no story needed
//   aft login    <tour.json> [--role <name>] [--manual]   save auth/<target>/<role>.json
//   aft doctor   [--target <app>]                     check this machine (+ targets' requirements.mjs); exit 1 if missing
//   aft --list-voices | --help | --version
//
// Target selection: --target <environment in tour.json> (alias --env), --base-url <url> or BASE_URL. Other flags:
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
// ran and its check failed: possibly a real app bug) · 5 APP error (the app showed its own error UI, see tour
// "errors": likely the environment or a bug). A failed run writes no tour.mp4; it leaves report.json,
// report.md, screens/failure.png, trace-failed.zip and recording-failed.webm in the run folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authFile, saveLogin } from './auth.mjs';
import { authTarget, ConfigError, loadTourJson, resolveConfig } from './declarative.mjs';
import { discover } from './discover.mjs';
import { doctor } from './doctor.mjs';
import { plan, readStory } from './plan.mjs';
import { Tour } from './recorder.mjs';
import { concat, cutClips, duration, muxScene, requireFfmpeg, writeCaptions } from './render.mjs';
import { parseScript, spokenText } from './script.mjs';
import { StepError, StopRun } from './steps.mjs';
import { writeTriage } from './triage.mjs';
import { defaultProvider, estimateSeconds, listVoices, speak } from './tts.mjs';
import { log, newRunDir, num, parseArgs, run } from './util.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = new Set(['_', 'record', 'noRecord', 'out', 'clips', 'voice', 'rate', 'tail', 'noCaptions', 'listVoices', 'speech', 'name',
  'prompt', 'story', 'llm', 'model', 'maxScenes', 'maxPages', 'tour', 'include', 'exclude', 'manual', 'baseUrl', 'script', 'style',
  'headed', 'headless', 'target', 'help', 'version', 'allowDraft', 'zip', 'pause', 'fromStep', 'untilStep']);
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

async function withRun(name, args, command, fn) {
  const r = startRun(name, args, command);
  try {
    endRun(r, 'done', (await fn(r.dir)) ?? {});
  } catch (e) {
    endRun(r, 'failed', { error: e.message.split('\n')[0] });
    throw e;
  }
}

// ---- Loading tours -----------------------------------------------------------------------------------------------

const envOf = args => args.target ?? args.env;

async function loadTour(file, args) {
  if (!file) throw new UsageError('Give a tour file (tour.json or .tour.mjs), or --script <file>');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new UsageError(`No such tour file: ${abs}`);
  if (abs.endsWith('.json')) return { def: loadTourJson(abs, { env: envOf(args), baseUrl: args.baseUrl }), dir: path.dirname(abs) };
  const def = (await import(pathToFileURL(abs).href)).default;
  def.name ??= path.basename(abs).replace(/\.tour\.mjs$|\.mjs$/, '');
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

async function recordWith(def, tourDir, outDir, scenes, args, { dryRun = false } = {}) {
  if (!def.record) throw new UsageError(`${def.name} has no record(ctx); render it without --record to use clips or title cards`);
  const tour = newTour(def, outDir, scenes, args, { dryRun });
  const options = Object.fromEntries(Object.entries(args).filter(([k]) => !ENGINE.has(k)));
  if (envOf(args)) options.env = envOf(args);
  const range = args.fromStep || args.untilStep ? { n: 0, from: Number(args.fromStep ?? 0), until: Number(args.untilStep ?? 0) } : null;
  const ctx = { tour, scenes, outDir, options, toolRoot, targetDir: tourDir, log, run, dryRun, report: [], range };
  const started = Date.now();
  try {
    await def.record(ctx);
    if (!dryRun) writeReport(outDir, def, ctx.report, { ms: Date.now() - started });
  } catch (e) {
    if (e instanceof StopRun) {
      log(`${e.message}; browser state kept in the trace`);
      if (args.pause && tour.page) { log('paused: the Playwright inspector is open; resume or close it to finish'); await tour.page.pause().catch(() => {}); }
      await tour.saveTrace('trace.zip');
      writeReport(outDir, def, ctx.report, { ms: Date.now() - started });
      return Object.assign(ctx.report, { partial: e.message });
    }
    const report = !dryRun ? writeReport(outDir, def, ctx.report, { ms: Date.now() - started, error: e }) : null;
    if (args.pause && tour.page && !tour.page.isClosed()) {
      log('paused at the failure: the Playwright inspector is open; resume or close it to finish (needs --headed)');
      await tour.page.pause().catch(() => {});
    }
    if (tour.page && !tour.page.isClosed()) await tour.screenshot('failure');
    await tour.saveTrace('trace-failed.zip');
    if (report) {
      const bundle = await writeTriage({ outDir, tour, raw: def.raw, report, entry: e.entry, error: e.entry?.error ?? e.message.split('\n')[0], zip: !!args.zip });
      console.error(`\nFAILED. Triage bundle: ${bundle}\n  read:  ${path.join(outDir, 'triage', 'report.md')}\n  trace: npx playwright show-trace "${path.join(outDir, 'trace-failed.zip')}"\n  hand off: give the triage folder (with PROMPT.md) to any AI assistant, or replay with --headed --pause${e.entry ? ` --until-step <n>` : ''}\n`);
    }
    const net = e.message.match(/net::(ERR_[A-Z_]+) at (\S+)/);
    if (net && /CONNECTION|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|TIMED_OUT|UNSAFE_PORT/.test(net[1]))
      throw new UnreachableError(`Can't reach ${net[2]} (${net[1]}). Is the app running there? Set the target with --base-url, BASE_URL or --target <environment>.`);
    if (/didn't come up/.test(e.message)) throw new UnreachableError(e.message.split('\n')[0]);
    throw e;
  } finally {
    await tour.close();
    // A failed run leaves Playwright's partial video under a random name; give it a predictable one.
    for (const f of fs.readdirSync(outDir).filter(f => /^page@.*\.webm$/.test(f))) {
      try { fs.renameSync(path.join(outDir, f), path.join(outDir, 'recording-failed.webm')); } catch { /* still being written; keep its name */ }
    }
  }
  return ctx.report;
}

// ---- Validate (dry run) ------------------------------------------------------------------------------------------

/**
 * report.json + report.md for a run: every step (action/check, locator, expected vs found, URL, time) and a verdict per
 * acceptance criterion: met (all its checks passed), NOT MET (a check failed), not run (the run stopped earlier) or
 * not checked (no verify covers it). Fully deterministic.
 */
function writeReport(outDir, def, steps, { ms, error } = {}) {
  const storyCriteria = def.story?.acceptanceCriteria ?? [];
  const ids = new Set([...storyCriteria.map((_, i) => String(i + 1)), ...steps.flatMap(s => s.criteria ?? [])]);
  (def.raw?.scenes ?? []).forEach(s => [s.criteria ?? []].flat().forEach(c => ids.add(String(c))));
  const planned = id => (def.raw?.scenes ?? []).reduce((n, s) => n + (s.steps ?? []).filter(st => 'verify' in st && [st.criterion ?? s.criteria ?? []].flat().map(String).includes(id)).length, 0);
  const criteria = [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(id => {
    const checks = steps.filter(s => s.kind === 'check' && s.criteria?.includes(id));
    const status = checks.some(c => !c.ok) ? 'NOT MET' : checks.length ? (checks.length < planned(id) ? 'met so far' : 'met') : planned(id) ? 'not run' : 'not checked';
    return { id, text: storyCriteria[Number(id) - 1] ?? '', status, checks: checks.length };
  });
  const failure = error ? (error.failure ?? (error instanceof UnreachableError ? 'unreachable' : 'error')) : null;
  const report = { tour: def.name, story: def.story?.id ?? null, result: failure ? `FAILED (${failure})` : 'PASSED', error: error?.message?.split('\n')[0] ?? null,
    seconds: Math.round((ms ?? 0) / 100) / 10, criteria, steps };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [`# ${report.story ? `${report.story} · ` : ''}${report.tour}: ${report.result}`, '',
    ...(report.error ? [`**${report.error}**`, ''] : []),
    '## Acceptance criteria', '', '| | criterion | status | checks |', '|---|---|---|---|',
    ...criteria.map(c => `| ${c.status === 'met' ? '✔' : c.status === 'NOT MET' ? '✘' : '·'} | ${esc(c.id)}${c.text ? `. ${esc(c.text)}` : ''} | ${c.status} | ${c.checks} |`),
    '', '## Steps', '', '| | scene | step | kind | action | locator | result | ms |', '|---|---|---|---|---|---|---|---|',
    ...steps.map(s => `| ${s.ok ? '✔' : '✘'} | ${esc(s.scene)} | ${s.step} | ${s.kind ?? ''}${s.criteria ? ` (${s.criteria.join(',')})` : ''} | ${s.action} | \`${esc(JSON.stringify(s.spec?.[s.action] ?? '')).slice(0, 70)}\` | ${s.ok ? (s.retried ? `ok after ${s.retried} retry` : 'ok') : `${s.failure?.toUpperCase()}: ${esc(s.error)}.${s.expected ? ` Expected ${esc(JSON.stringify(s.expected))}; ${esc(s.found)}.` : ''} At ${esc(s.url)}`} | ${s.ms ?? ''} |`),
  ];
  fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n') + '\n');
  log(`report: ${path.join(outDir, 'report.md')}`);
  return report;
}

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

/** The app URL for generate/all: --base-url, BASE_URL, or the --tour target file (its environment or baseUrl). */
function targetUrl(args) {
  if (args.baseUrl || process.env.BASE_URL || !args.tour) return args.baseUrl ?? process.env.BASE_URL;
  const raw = resolveConfig(JSON.parse(fs.readFileSync(args.tour, 'utf8')), { env: envOf(args) });
  return raw.baseUrl ? new URL(raw.startPath ?? '', raw.baseUrl.replace(/\/?$/, '/')).href : undefined;
}

function loginStepsFor(args) {
  if (!args.tour) return {};
  const raw = resolveConfig(JSON.parse(fs.readFileSync(args.tour, 'utf8')), { env: envOf(args), baseUrl: args.baseUrl });
  raw.name ??= path.basename(args.tour).replace(/\.tour\.json$|\.json$/, '');
  if (!raw.login) return { ready: raw.ready, ignoreHTTPSErrors: raw.ignoreHTTPSErrors, paths: raw.discover?.paths ?? [], errors: raw.errors };
  const state = authFile(toolRoot, authTarget(raw, envOf(args)), args.role ?? raw.login.role);
  const common = { ready: raw.ready, ignoreHTTPSErrors: raw.ignoreHTTPSErrors, paths: raw.discover?.paths ?? [], errors: raw.errors };
  return fs.existsSync(state) ? { ...common, storageState: state } : { ...common, loginSteps: raw.login.steps };
}

/** Discovers (when there's a URL), plans into out, and merges login/environments/hooks/mask from --tour. */
async function generateInto(out, args, { url, story, name }) {
  const discovery = url
    ? await discover({ url, outDir: out, maxPages: Number(args.maxPages ?? 12), include: args.include, exclude: args.exclude, ...loginStepsFor(args) })
    : null;
  const tour = await plan({ discovery, outDir: out, name: safeName(name), prompt: args.prompt, story, style: args.style, llm: args.llm, model: args.model,
    maxScenes: Number(args.maxScenes ?? 6), baseUrl: url ? undefined : args.baseUrl });
  const tourFile = path.join(out, 'tour.json');
  if (args.tour) { // the app's own settings from a hand-written tour.json: login, environments, hooks, mask, timeouts
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
    if (!(await doctor({ toolRoot, target: args.target }))) process.exitCode = 1;
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
      const def = loadTourJson(tourFile, { env: envOf(args), baseUrl: args.baseUrl });
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
      const def = loadTourJson(tourFile, { env: envOf(args), baseUrl: args.baseUrl });
      return { tour: tourFile, ...(await render(def, out, out, { ...args, record: !args.noRecord })) };
    });
  },

  async login(args) {
    const file = args.script ?? args._[1];
    if (!file) throw new UsageError('Usage: aft login <tour.json> [--target <env>] [--role <name>] [--manual]');
    const raw = resolveConfig(JSON.parse(fs.readFileSync(file, 'utf8')), { env: envOf(args), baseUrl: args.baseUrl });
    raw.name ??= path.basename(file).replace(/\.tour\.json$|\.json$/, '');
    const state = authFile(toolRoot, authTarget(raw, envOf(args)), args.role ?? raw.login?.role);
    await saveLogin({ baseUrl: raw.baseUrl, steps: raw.login?.steps, file: state, manual: !!args.manual, viewport: raw.viewport, timeouts: raw.timeouts,
      ready: raw.ready, ignoreHTTPSErrors: raw.ignoreHTTPSErrors });
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
  const code = e instanceof StepError ? (e.failure === 'criterion' ? 4 : e.failure === 'app' ? 5 : 2) : e instanceof UnreachableError ? 3 : 1;
  console.error(code === 1 && !(e instanceof UsageError) && !(e instanceof ConfigError) ? e.stack ?? e : `error: ${e.message}`);
  process.exit(code);
});
