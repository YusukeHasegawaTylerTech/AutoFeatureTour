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
// --on-error fail|skip. Credentials: env vars or a .env file (never committed).
//
// Every command writes into its own run folder, out/<name>/<YYYYMMDD-HHMMSS>-<id>/ (story id in the name when there
// is one), never reused; out/<name>/latest.json and runs.jsonl are pointers only.
//
// Exit codes: 0 ok · 1 usage/config/unexpected error · 2 a step or verify failed (or validate found unresolved
// steps) · 3 the app wasn't reachable. Failures leave failure.png and trace-failed.zip in the run folder.

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
import { StepError } from './steps.mjs';
import { defaultProvider, estimateSeconds, listVoices, speak } from './tts.mjs';
import { log, newRunDir, num, parseArgs, run } from './util.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = new Set(['_', 'record', 'noRecord', 'out', 'clips', 'voice', 'rate', 'tail', 'noCaptions', 'listVoices', 'speech', 'name',
  'prompt', 'story', 'llm', 'model', 'maxScenes', 'maxPages', 'tour', 'include', 'exclude', 'manual', 'baseUrl', 'script', 'style',
  'headed', 'headless', 'target', 'help', 'version']);
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

const runName = (def, args) => args.name ?? (def.story?.id ? `${def.story.id}-${def.name}` : def.name);

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
  const ctx = { tour, scenes, outDir, options, toolRoot, targetDir: tourDir, log, run, dryRun, report: [] };
  try {
    await def.record(ctx);
  } catch (e) {
    if (tour.page && !tour.page.isClosed()) await tour.screenshot('failure');
    await tour.saveTrace('trace-failed.zip');
    if (/didn't come up|net::ERR_(CONNECTION|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|TIMED_OUT)/.test(e.message)) throw new UnreachableError(e.message);
    throw e;
  } finally {
    await tour.close();
    // A failed run leaves Playwright's partial video under a random name; give it a predictable one.
    for (const f of fs.readdirSync(outDir).filter(f => /^page@.*\.webm$/.test(f)))
      fs.renameSync(path.join(outDir, f), path.join(outDir, 'recording-failed.webm'));
  }
  return ctx.report;
}

// ---- Validate (dry run) ------------------------------------------------------------------------------------------

async function validate(def, tourDir, outDir, args) {
  if (def.scenes && !def.record) throw new UsageError('Nothing to validate');
  if (!def.raw) log('note: a .tour.mjs is code; validate runs it without recording but only reports errors it throws');
  const scenes = scenesOf(def, tourDir);
  const report = await recordWith(def, tourDir, outDir, scenes, args, { dryRun: true });
  const failed = report.filter(r => !r.ok);
  const blocking = failed.filter(r => !r.optional);
  const lines = [`# Validation: ${def.name}`, '', `${report.length} steps checked: ${report.length - failed.length} resolved, ${failed.length} failed` +
    ` (${blocking.length} blocking, ${failed.length - blocking.length} optional).`, '', '| | scene | step | action | target | result |', '|---|---|---|---|---|---|'];
  for (const r of report) {
    const target = JSON.stringify(r.spec[r.action]).slice(0, 60);
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
    await recordWith(def, tourDir, outDir, scenes, args);
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

function loginStepsFor(args) {
  if (!args.tour) return {};
  const raw = resolveConfig(JSON.parse(fs.readFileSync(args.tour, 'utf8')), { env: envOf(args), baseUrl: args.baseUrl });
  raw.name ??= path.basename(args.tour).replace(/\.tour\.json$|\.json$/, '');
  if (!raw.login) return {};
  const state = authFile(toolRoot, authTarget(raw, envOf(args)), args.role ?? raw.login.role);
  return fs.existsSync(state) ? { storageState: state } : { loginSteps: raw.login.steps };
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
    for (const k of ['login', 'environments', 'hooks', 'mask', 'timeouts', 'launch', 'viewport', 'voice', 'pronounce']) if (base[k]) tour[k] = base[k];
    tour.target = base.target ?? base.name;
    fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2));
  }
  log(`script: ${tour.scenes.length} scenes → ${tourFile} (narration for review: ${path.join(out, 'script.md')})`);
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
    const url = args.baseUrl ?? process.env.BASE_URL;
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
    const url = args.baseUrl ?? process.env.BASE_URL;
    if (!url) throw new UsageError('Usage: aft all --story <file|text> --base-url <url> [--llm claude]');
    const name = args.name ?? storyName(story, url);
    let blocking = 0;
    await withRun(name, args, 'all', async out => {
      const { tour, tourFile } = await generateInto(out, args, { url, story, name });
      if (tour.draft) { log('the script is a draft (scenes without steps): edit tour.json, then aft validate / aft run it'); return { tour: tourFile, draft: true }; }
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
      if (tour.draft) { log('the script is a draft: edit tour.json, then render it'); return { tour: tourFile, draft: true }; }
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
    await saveLogin({ baseUrl: raw.baseUrl, steps: raw.login?.steps, file: state, manual: !!args.manual, viewport: raw.viewport, timeouts: raw.timeouts });
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
  const code = e instanceof StepError ? 2 : e instanceof UnreachableError ? 3 : 1;
  console.error(code === 1 && !(e instanceof UsageError) && !(e instanceof ConfigError) ? e.stack ?? e : `error: ${e.message}`);
  process.exit(code);
});
