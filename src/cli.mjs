#!/usr/bin/env node
// AutoFeatureTour CLI. Every command writes into its own run folder, out/<name>/<YYYYMMDD-HHMMSS>-<id>/, and never
// touches another run's files; out/<name>/latest.json points at the newest finished run and runs.jsonl lists them all.
//
//   aft render   <tour.json|tour.mjs> [--record] [--env <name>] [--base-url <url>] [--role <name>] [--speech sapi|silent]
//   aft discover <url> [--max-pages 12] [--tour <tour.json> (for login)] [--include <regex>] [--exclude <regex>]
//   aft plan     <discovery.json|run folder> [--prompt "<brief>"] [--story <file|text>] [--llm claude] [--max-scenes 6]
//   aft auto     <url> [--prompt ...] [--story ...] [--llm claude] [--no-record]     discover → plan → render, one run
//   aft login    <tour.json> [--env <name>] [--role <name>] [--manual]            save auth/<target>/<role>.json
//   aft --list-voices
//
// Common: --out <folder> (used only if empty or new; otherwise a run subfolder is made inside), --name <run name>,
// --voice, --rate -10..10, --tail <seconds>, --no-captions, --on-error fail|skip. `aft <tour>` = `aft render <tour>`.
// Credentials: env vars or a .env file (never committed) in the current folder; see tour.json "{env:NAME}".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authFile, saveLogin } from './auth.mjs';
import { authTarget, loadTourJson, resolveConfig } from './declarative.mjs';
import { discover } from './discover.mjs';
import { plan, readStory } from './plan.mjs';
import { Tour } from './recorder.mjs';
import { concat, cutClips, duration, muxScene, requireFfmpeg, writeCaptions } from './render.mjs';
import { parseScript, spokenText } from './script.mjs';
import { defaultProvider, listVoices, speak } from './tts.mjs';
import { log, newRunDir, num, parseArgs, run } from './util.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = new Set(['_', 'record', 'noRecord', 'out', 'clips', 'voice', 'rate', 'tail', 'noCaptions', 'listVoices', 'speech', 'name',
  'prompt', 'story', 'llm', 'model', 'maxScenes', 'maxPages', 'tour', 'include', 'exclude', 'manual', 'baseUrl']);
const safeName = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tour';

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
  const base = path.join(toolRoot, 'out', safeName(name));
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
  // Appends are atomic enough for one short line; latest.json is written to a temp name and renamed.
  fs.appendFileSync(path.join(r.base, 'runs.jsonl'), JSON.stringify({ dir: path.basename(r.dir), status, at: r.info.finishedAt, ...extra }) + '\n');
  if (status === 'done') {
    const tmp = path.join(r.base, `.latest-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ dir: r.dir, at: r.info.finishedAt, ...extra }, null, 2));
    fs.renameSync(tmp, path.join(r.base, 'latest.json'));
  }
}

// ---- Loading tours -----------------------------------------------------------------------------------------------

async function loadTour(file, args) {
  const abs = path.resolve(file);
  if (abs.endsWith('.json')) return { def: loadTourJson(abs, { env: args.env, baseUrl: args.baseUrl }), dir: path.dirname(abs) };
  const def = (await import(pathToFileURL(abs).href)).default;
  def.name ??= path.basename(abs).replace(/\.tour\.mjs$|\.mjs$/, '');
  return { def, dir: path.dirname(abs) };
}

const runName = (def, args) => args.name ?? (def.story?.id ? `${def.story.id}-${def.name}` : def.name);

// ---- Render (narrate → record → cut → mux → join) ----------------------------------------------------------------

async function render(def, tourDir, outDir, args) {
  requireFfmpeg();
  const options = Object.fromEntries(Object.entries(args).filter(([k]) => !ENGINE.has(k)));
  const tail = args.tail !== undefined ? Number(args.tail) : 0.75;
  const provider = args.speech ?? (args.voice === 'silent' ? 'silent' : defaultProvider());

  const scenes = def.scenes
    ? def.scenes.map((s, i) => ({ number: i + 1, id: `scene-${String(i + 1).padStart(2, '0')}`, title: s.title, narration: s.narration, cues: [] }))
    : parseScript(path.resolve(tourDir, def.script));
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
    if (!def.record) throw new Error(`${def.name} has no record(ctx); run without --record to use clips or title cards`);
    const tour = new Tour({ outDir, viewport: def.viewport, narration: scenes.map(s => ({ id: s.id, seconds: s.seconds })) });
    const ctx = { tour, scenes, outDir, options, toolRoot, targetDir: tourDir, log, run };
    try {
      await def.record(ctx);
    } catch (e) {
      await tour.saveTrace('trace-failed.zip');
      if (tour.page) await tour.screenshot('failure');
      throw e;
    } finally {
      await tour.close();
    }
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

// ---- Commands ----------------------------------------------------------------------------------------------------

async function withRun(name, args, command, fn) {
  const r = startRun(name, args, command);
  try {
    const extra = (await fn(r.dir)) ?? {};
    endRun(r, 'done', extra);
  } catch (e) {
    endRun(r, 'failed', { error: e.message.split('\n')[0] });
    throw e;
  }
}

function loginStepsFor(args) {
  if (!args.tour) return {};
  const raw = resolveConfig(JSON.parse(fs.readFileSync(args.tour, 'utf8')), { env: args.env, baseUrl: args.baseUrl });
  raw.name ??= path.basename(args.tour).replace(/\.tour\.json$|\.json$/, '');
  if (!raw.login) return {};
  const state = authFile(toolRoot, authTarget(raw, args.env), args.role ?? raw.login.role);
  return fs.existsSync(state) ? { storageState: state } : { loginSteps: raw.login.steps };
}

const commands = {
  async render(args) {
    const file = args._[1];
    if (!file) throw new Error('Usage: aft render <tour.json|tour.mjs> [--record]');
    const { def, dir } = await loadTour(file, args);
    await withRun(runName(def, args), args, 'render', out => render(def, dir, out, args));
  },

  async discover(args) {
    const url = args._[1];
    if (!url) throw new Error('Usage: aft discover <url>');
    await withRun(args.name ?? new URL(url).hostname, args, 'discover', async out => {
      const d = await discover({ url, outDir: out, maxPages: Number(args.maxPages ?? 12), include: args.include, exclude: args.exclude, ...loginStepsFor(args) });
      return { pages: d.pages.length, discovery: path.join(out, 'discovery.json') };
    });
  },

  async plan(args) {
    let input = args._[1];
    if (!input) throw new Error('Usage: aft plan <discovery.json|run folder> [--prompt ...] [--story ...] [--llm claude]');
    if (fs.statSync(input).isDirectory()) input = path.join(input, 'discovery.json');
    const discovery = JSON.parse(fs.readFileSync(input, 'utf8'));
    const story = readStory(args.story);
    const name = args.name ?? (story?.id ?? new URL(discovery.origin).hostname);
    await withRun(name, args, 'plan', async out => {
      const tour = await plan({ discovery, outDir: out, name: safeName(name), prompt: args.prompt, story, llm: args.llm, model: args.model,
        maxScenes: Number(args.maxScenes ?? 6), baseUrl: args.baseUrl });
      log(`plan: ${tour.scenes.length} scenes → ${path.join(out, 'tour.json')} (review script.md, then: aft render "${path.join(out, 'tour.json')}" --record)`);
      return { tour: path.join(out, 'tour.json'), scenes: tour.scenes.length };
    });
  },

  async auto(args) {
    const url = args._[1];
    if (!url) throw new Error('Usage: aft auto <url> [--prompt ...] [--story ...] [--llm claude]');
    const story = readStory(args.story);
    const name = args.name ?? (story?.id ? `${story.id}-${new URL(url).hostname}` : new URL(url).hostname);
    await withRun(name, args, 'auto', async out => {
      const discovery = await discover({ url, outDir: out, maxPages: Number(args.maxPages ?? 12), include: args.include, exclude: args.exclude, ...loginStepsFor(args) });
      const tour = await plan({ discovery, outDir: out, name: safeName(name), prompt: args.prompt, story, llm: args.llm, model: args.model,
        maxScenes: Number(args.maxScenes ?? 6) }); // scene urls are absolute paths on the app's origin
      const tourFile = path.join(out, 'tour.json');
      if (args.tour) { // reuse the app's login (and launch/timeouts) from a hand-written tour.json
        const base = JSON.parse(fs.readFileSync(args.tour, 'utf8'));
        Object.assign(tour, { login: base.login, target: base.target ?? base.name, timeouts: base.timeouts, environments: base.environments });
        fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2));
      }
      if (tour.draft) { log('story draft has scenes without steps; edit tour.json, then render it'); return { tour: tourFile, draft: true }; }
      const def = loadTourJson(tourFile, { env: args.env, baseUrl: args.baseUrl });
      const result = await render(def, out, out, { ...args, record: !args.noRecord });
      return { tour: tourFile, ...result };
    });
  },

  async login(args) {
    const file = args._[1];
    if (!file) throw new Error('Usage: aft login <tour.json> [--env <name>] [--role <name>] [--manual]');
    const raw = resolveConfig(JSON.parse(fs.readFileSync(file, 'utf8')), { env: args.env, baseUrl: args.baseUrl });
    raw.name ??= path.basename(file).replace(/\.tour\.json$|\.json$/, '');
    const state = authFile(toolRoot, authTarget(raw, args.env), args.role ?? raw.login?.role);
    await saveLogin({ baseUrl: raw.baseUrl, steps: raw.login?.steps, file: state, manual: !!args.manual, viewport: raw.viewport, timeouts: raw.timeouts });
  },
};

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.listVoices) { console.log((await listVoices()).join('\n')); return; }
  const cmd = args._[0];
  if (!cmd) throw new Error('Usage: aft render|discover|plan|auto|login ... (see the top of src/cli.mjs or the README)');
  if (commands[cmd]) return commands[cmd](args);
  if (/\.(mjs|json)$/.test(cmd)) return commands.render({ ...args, _: ['render', ...args._] });
  throw new Error(`Unknown command "${cmd}"`);
}

main().catch(e => { console.error(e.stack ?? e); process.exit(1); });
