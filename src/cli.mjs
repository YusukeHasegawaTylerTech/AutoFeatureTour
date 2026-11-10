#!/usr/bin/env node
// AutoFeatureTour CLI: story → script (editable tour.json) → validate → run (record) → post-process (narration,
// captions, video). Non-interactive unless you ask for it (login --manual, --headed).
//
//   aft generate --story <file|text> [--platform <name> | --base-url <url>] [--llm claude] [--style verification|demo|training] [--prompt ...]
//   aft validate <tour.json> | --script <tour.json>   dry run: checks every step resolves, nothing recorded
//   aft run      <tour.json|tour.mjs>                 record the video (render --record)
//   aft generate --story <file|text> --platform <name> --llm claude --converse [--target <env>] [--role <r>] [--no-discover] [--headless]
//                                                    a conversation: the agent explores the live app (on a stage), asks, you decide;
//                                                    exit 0 with data.state "waiting" (data.questions) or "done"
//   aft converse <run> [--say "…"] [--answer q3=Approve ...] | --record N [--after-step J] | --steps [--drop-last] | --stop
//                | --accept p1 | --reject p1 | --finish [--force] | --end [--keep]    continue it (no flag: its state)
//   aft all      --story <file|text> --base-url <url> [--llm claude]   generate → validate → run, one run folder
//   aft render   <tour>  [--record]                   narration over slides, clips or title cards, or a recording
//   aft generate --from <doc.md> [--llm claude] [--platform <name>] [--max-scenes 12]
//                                                    an explainer: a document's outline as narrated slide scenes (no app)
//   aft scratch  [<name>] [--from <doc.md>] [--pages] [--force]   one-off tours in scratch/<name>/ (git-ignored); no name: the list
//   aft discover <url>   [--max-pages 12]             crawl screens (used by generate/auto)
//   aft plan     <discovery.json|run folder> [--story ...] [--prompt ...] [--llm claude]
//   aft auto     <url> [--prompt ...]                 discover → plan → run, no story needed
//   aft export   <tour.json|run folder>             one self-contained <name>.aft.json (fragments inlined, files embedded, the last result)
//   aft import   <file.aft.json> --platform <name> [--name n] [--force]   into platforms/<name>/tours/ (lists missing fixtures)
//   aft suggest-fix <run folder> --finding "<id>" [--llm claude]   AI proposal for a failure (a step, or a story workaround); writes nothing to the tour
//   aft login    --platform <name> | <tour.json> [--target <env>] [--role <name>] [--manual]   save auth/<platform>/<env>/<role>.json
//   aft platform list | init <name> [--base-url <url>] [--no-login] | discover <name> | check <name>   onboard an app (AGENTS.md, Platforms)
//   aft schema   [tour|platform|environments|login|fragment|fixture]   print a definition file's JSON Schema (no type: the list);
//                                                    --write <folder>: a copy in <folder>/.aft-schemas/ for files outside the checkout
//   aft validate <platform.json|environments.json|login.json|fragment|fixture|tour> --schema-only   check a file against its schema
//   aft cleanup  [<run folder>] [--platform p] [--target env] [--tag <prefix>] [--older-than 2d] [--all] [--dry-run]
//                                                    finish the undo of runs that left data behind (crash, Ctrl+C, failed teardown);
//                                                    no run, --all, --platform or --tag: only lists them
//   aft reset    --platform <name> [--target <env>]  the environment's "reset" hooks (never a shared one); --reset on run/validate
//   aft batch    <tour.json | folder | glob>... [--target <env>] [--reset] [--validate-only] [--stop-on-fail]
//                                                    several tours in order, one reset first; each in its own run folder;
//                                                    out/batch/<run>/batch.json (aft-batch/1) + batch.md; exit: the first failure's
//   aft doctor   [--platform <name>]                  check this machine (+ platforms' requirements.mjs); exit 1 if missing
//   aft session  start|status|stop [--platform <name>] [--target <env>] [--role <r>] [--session <name>] [--headed]
//                                                    a warm, signed-in browser for the commands below (stop: only what it started)
//   aft stage    <tour.json|run folder> [--target <env>] [--as <role>] [--until-scene N [--step J] | --until-step N | --setup-only]
//                [--keep] [--redo [--force]] [--headless]   do / redo until here: the tour unrecorded up to that point,
//                                                    then the live app is handed off (headed browser, data in place)
//   aft stage    list | end <name> [--keep]          the live stages; end one (undo its data in reverse, or keep it)
//   aft snapshot [--url <path>] [--screenshot]        the page now: URL, title, ARIA snapshot, visible text
//   aft locate   "<target>"                           how a step target resolves: strategy, matches, visible, alternatives
//   aft try-step '<step | [steps]>' [--url <path>]    perform steps live (fragments too): result per step + ARIA after
//     (snapshot/locate/try-step use --session, or the only session for --platform, else a one-shot browser)
//   aft session  wait [<call id>] [--session <name>] [--timeout <s>]
//                                                    a session (or stage) call the CLI stopped waiting for keeps running:
//                                                    wait for it (no id: the running one, else the last) and print its
//                                                    result, same exit code; AFT_CALL_TIMEOUT=<s> caps a call's wait
//   aft ui       [--port 4777] [--no-open] [--root <checkout>]   the local web UI (ui/server.mjs; Ctrl+C stops it)
//   aft --list-voices | --help | --version
//
// Git Bash rewrites arguments that start with / (a path like #/case/1 or /orders) into Windows paths; aft refuses
// such arguments. Run with MSYS_NO_PATHCONV=1 (export it), or use PowerShell / cmd.
//
// --json: on every command, one JSON document on stdout ("schema": "aft-cli/1": command, ok, exitCode, class, runDir,
// data | error); all logs go to stderr. Without it, stdout is human-readable.
// Target selection: a tour names its platform (platforms/<name>/); --target <environment> (alias --env) and --role pick
// among the platform's; --base-url <url> or BASE_URL override the URL. --platform <name> for generate/discover/login. Other flags:
// --out <folder>, --name <run name>, --headed, --speech sapi|silent, --voice, --rate, --tail, --no-captions,
// --on-error fail|skip, --allow-draft (record a script that still has unresolved/empty scenes), --no-trim (keep long
// waits in the video; see "video" in the tour/platform).
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
import { ConfigError, loadTourJson, materialize, missingCredentials } from './declarative.mjs';
import { check as checkSchema, schemaFor, schemaRef, schemasDir, schemaTypes, writeSchemaCopy } from './schema.mjs';
import { OUTLINE_SCHEMA, OUTLINE_SYSTEM, outline, renderSlides } from './slides.mjs';
import { appSettingsFor } from './cli-app.mjs';
import { platformCommand } from './platform-cli.mjs';
import { call, parseArg, waitCall, readSessions, Session, sessionName, sessionsDir, startDaemon } from './session.mjs';
import { loadPlatform } from './platform.mjs';
import { describePoint, endStage, listStages, stageName, stagePoint, stageSource, stageView, startStage } from './stage.mjs';
import { exportTour, importTour } from './exchange.mjs';
import { notesForPrompt, readNotes, snapshotNotes } from './notes.mjs';
import { discover } from './discover.mjs';
import { doctor } from './doctor.mjs';
import { claude, inventoryFor, plan, readStory, toScriptMarkdown } from './plan.mjs';
import { applyAnswers, decideProposal, finish, newConversation, openQuestions, parseAnswers, readConversation, recordedSteps, saveConversation, startRecording, stopRecording, turn, view as conversationView, writeDraft } from './converse.mjs';
import { Tour } from './recorder.mjs';
import { concat, cutClips, duration, muxScene, requireFfmpeg, trimPlan, writeCaptions } from './render.mjs';
import { parseScript, spokenText } from './script.mjs';
import { runSteps, StepError, StopRun } from './steps.mjs';
import { Ledger, openLedgers, parseAge } from './ledger.mjs';
import { expandTours, runBatch } from './batch.mjs';
import { finishUndo, resetEnvironment } from './fixtures.mjs';
import { CLASSES, classify, exitCode, Failure, summaryLine } from './failures.mjs';
import { criteriaOf, finalize, progress } from './triage.mjs';
import { review as reviewOf } from './review.mjs';
import { suggestFix } from './fix.mjs';
import { defaultProvider, estimateSeconds, listVoices, speak } from './tts.mjs';
import { log, newRunDir, num, parseArgs, run, sleep } from './util.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = new Set(['_', 'record', 'noRecord', 'out', 'clips', 'voice', 'rate', 'tail', 'noCaptions', 'listVoices', 'speech', 'name',
  'prompt', 'story', 'llm', 'model', 'maxScenes', 'maxPages', 'tour', 'include', 'exclude', 'manual', 'baseUrl', 'script', 'style',
  'headed', 'headless', 'target', 'help', 'version', 'allowDraft', 'from', 'write', 'zip', 'pause', 'fromStep', 'untilStep', 'platform', 'json', 'noTrim', 'reset', 'tag', 'olderThan', 'all', 'dryRun', 'validateOnly', 'stopOnFail']);
const safeName = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tour';

/**
 * `aft generate --from <doc.md>`: a document (findings, a spike write-up, release notes) as an explainer tour of
 * slide scenes, in a new run folder (tour.json + script.md). No AI: the document's outline (src/slides.mjs outline);
 * --llm claude: Claude writes the slides and the narration from it (it sends the document to Claude). --platform
 * names the platform the tour belongs to (so app scenes can be added between the slides later).
 */
async function generateExplainer(args) {
  const docFile = path.resolve(String(args.from));
  if (!fs.existsSync(docFile)) throw new UsageError(`--from ${args.from}: no such file`);
  const text = fs.readFileSync(docFile, 'utf8');
  const docDir = path.dirname(docFile);
  const max = Number(args.maxScenes ?? 12);
  const heuristic = outline(text, { dir: docDir, maxScenes: max });
  if (!heuristic.scenes.length) throw new UsageError(`${args.from}: nothing to outline (no headings or text)`);
  const name = safeName(args.name ?? heuristic.title);
  return withRun(name, args, 'generate', async out => {
    let title = heuristic.title, scenes = heuristic.scenes, by = 'outline';
    if (args.llm === 'claude') {
      log('sending the document to Claude for slides and narration');
      const r = await claude({ system: OUTLINE_SYSTEM, input: JSON.stringify({ maxScenes: max, document: text }), schema: OUTLINE_SCHEMA, cwd: out, model: args.model });
      title = r.title; by = 'claude';
      scenes = r.scenes.slice(0, max).map(s => ({ title: s.title, narration: s.narration, slide: { heading: s.slide.heading ?? s.title, ...s.slide } }));
    } else if (args.llm) throw new UsageError(`Unknown planner "${args.llm}" (claude)`);
    // Images the document points at come along, relative to the run folder's tour.json.
    for (const s of scenes) if (s.slide.image) s.slide.image = path.relative(out, s.slide.image).split(path.sep).join('/');
    if (args.platform) loadPlatform(toolRoot, args.platform); // fails early on a typo
    const tour = { $schema: schemaRef(out, 'tour'), name, ...(args.platform ? { platform: args.platform } : {}), style: 'explainer',
      comment: `Generated from ${path.basename(docFile)} (${by}). Edit the slides and narration, add app scenes (steps) between them if useful, then aft run it.`,
      generatedBy: by, plannedAt: new Date().toISOString(), scenes };
    const tourFile = path.join(out, 'tour.json');
    fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2) + '\n');
    fs.writeFileSync(path.join(out, 'script.md'), toScriptMarkdown(tour));
    log(`${scenes.length} slide scene(s) from ${path.basename(docFile)} (${by}); next: aft render "${tourFile}" (a preview), or aft run it`);
    return { tour: tourFile, scenes: scenes.length, title, generatedBy: by };
  });
}

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
  snapshotRunNotes(dir, args);
  log(`run folder: ${dir}`);
  return { dir, info, base };
}

/** The platform a command is about: --platform, else the tour (or run folder) it was given. */
function platformOfArgs(args) {
  if (args.platform) return { name: args.platform, from: undefined };
  let f = args._?.[1] ?? args.script ?? args.tour;
  if (!f || typeof f !== 'string' || !fs.existsSync(f)) return null;
  try {
    if (fs.statSync(f).isDirectory()) f = path.join(f, 'tour.json');
    const t = JSON.parse(fs.readFileSync(f, 'utf8'));
    return t?.platform ? { name: t.platform, from: path.dirname(path.resolve(f)) } : null;
  } catch { return null; }
}

/** notes.md: the platform's notes as they were when the run started (nothing when it has none). */
function snapshotRunNotes(dir, args) {
  try {
    const p = platformOfArgs(args);
    if (!p) return;
    const pl = loadPlatform(toolRoot, p.name, { from: p.from });
    snapshotNotes(dir, pl.dir, pl.name);
  } catch { /* a bad platform name is reported by the command itself */ }
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
/** For --json: the run folder of the command, and data to report even when the command fails (validate). */
let lastRunDir = null, lastData = null;

async function withRun(name, args, command, fn) {
  const r = startRun(name, args, command);
  currentRun = r;
  lastRunDir = r.dir;
  try {
    const result = (await fn(r.dir)) ?? {};
    // A dry run whose steps can't all be resolved is a failed run, even though the command itself finished.
    endRun(r, result.blocking ? 'failed' : 'done', result.blocking ? { ...result, class: 'script', exitCode: CLASSES.script.exit } : result);
    return { runDir: r.dir, ...result };
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
let batchState = null;
async function onSignal(signal) {
  // A batch: the running tour handles the signal itself; the batch stops after it (a second Ctrl+C quits at once).
  if (batchState && !batchState.stop) { batchState.stop = true; console.error(`\n${signal}: the batch stops after the current tour (press Ctrl+C again to quit at once)`); return; }
  if (batchState) { batchState.child?.kill(); process.exit(130); }
  if (stopping) { console.error('\nforced exit'); process.exit(130); }
  stopping = true;
  console.error(`\n${signal}: stopping; writing the partial report and bundle (press Ctrl+C again to quit at once)`);
  const e = new Failure('interrupted', `interrupted by ${signal}`);
  const work = (async () => {
    if (active) {
      await active.tour.saveTrace('trace-failed.zip').catch(() => {});
      // Undo what the run set up (browser steps while the browser is still there), within a time limit.
      await active.undo?.({ deadline: Date.now() + 30000 }).catch(e => console.error('cleanup failed: ' + e.message));
      const report = await active.finalize(e, { complete: false }).catch(() => null);
      if (report) printFailure(report, active.outDir);
      await active.tour.close().catch(() => {});
    } else if (currentRun) await finalize({ outDir: currentRun.dir, error: e, complete: false }).catch(() => {});
    if (currentRun) endRun(currentRun, 'interrupted', { class: 'interrupted', exitCode: 130 });
  })();
  await Promise.race([work, sleep(45000)]);
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
    ? def.scenes.map((s, i) => ({ number: i + 1, id: `scene-${String(i + 1).padStart(2, '0')}`, title: s.title, narration: s.narration ?? '', cues: [], ...(s.offCamera ? { offCamera: true } : {}), ...(s.slide ? { slide: s.slide } : {}) }))
    : parseScript(path.resolve(tourDir, def.script));
}

function newTour(def, outDir, scenes, args, extra = {}) {
  // Slides are drawn, not recorded: the browser's narration plan has only the recorded scenes.
  return new Tour({ outDir, viewport: def.viewport, mask: def.mask, headless: !args.headed,
    narration: scenes.filter(s => !s.offCamera && !s.slide).map(s => ({ id: s.id, seconds: s.seconds ?? estimateSeconds(s.narration) })), ...extra });
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
  const done = async (error, extra = {}) => (dryRun ? null : finalize({ outDir, def, steps: ctx.report, tour, error, ms: Date.now() - started, zip: !!args.zip, secrets,
    fixtures: ctx.fixtures ?? ctx.ledger?.summary() ?? [], artifacts: ctx.artifacts ?? [], ...extra, warnings: [...(def.warnings ?? []), ...(extra.warnings ?? [])] }));
  active = { outDir, tour, finalize: (error, extra) => done(error, extra), undo: o => ctx.undo?.(o) };
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
    // Known issues that fired and mocks that answered, for the dry run's review (a run's report has them already).
    ctx.report.firings = tour.workarounds?.firings ?? [];
    ctx.report.mocks = tour.mocks ?? [];
    ctx.report.fixtures = ctx.fixtures ?? ctx.ledger?.summary() ?? [];
    ctx.report.artifacts = ctx.artifacts ?? [];
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
    report.firstCause ? `  first cause: ${report.firstCause.kind === 'network' ? `${report.firstCause.method} ${report.firstCause.request.replace(/\?.*$/, '')} ${report.firstCause.status ?? report.firstCause.failure}${report.firstCause.body ? `: ${report.firstCause.body.slice(0, 120)}` : ''}` : report.firstCause.kind === 'workaround' ? `known issue "${report.firstCause.name}"` : report.firstCause.text?.split('\n')[0]} (during ${report.firstCause.stepKey})` : null,
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
  // Slides are drawn (outDir/slides/), so a text that doesn't fit shows up here; the browser runs only for the rest.
  const slides = await drawSlides(def, scenes, tourDir, outDir);
  const ran = def.needsBrowser === false ? Object.assign([], { firings: [], mocks: [], fixtures: [], artifacts: [] })
    : await recordWith(def, tourDir, outDir, scenes, args, { dryRun: true });
  const report = [...issues, ...slides.entries, ...ran];
  const failed = report.filter(r => !r.ok);
  const blocking = failed.filter(r => !r.optional && !r.knownIssue);
  const lines = [`# Validation: ${def.name}`, '', `${report.length} steps checked: ${report.length - failed.length} resolved, ${failed.length} failed` +
    ` (${blocking.length} blocking, ${failed.length - blocking.length} optional).`, '', '| | scene | step | action | target | result |', '|---|---|---|---|---|---|'];
  for (const r of report) {
    // A check shows its condition too (state, text, count…), not only what it looks at.
    const cond = r.spec && r.action === 'verify' ? ['text', 'exactText', 'value', 'count', 'state'].filter(k => k in r.spec).map(k => ` ${k}=${JSON.stringify(r.spec[k])}`).join('') : '';
    const target = r.spec ? (JSON.stringify(r.spec[r.action]).slice(0, 60) + cond).slice(0, 110) : '';
    const result = r.ok ? 'ok' : `${r.error}${r.suggestions?.length ? `. Closest: ${r.suggestions.map(s => `"${s}"`).join(', ')}` : ''}`;
    lines.push(`| ${r.ok ? '✔' : r.optional ? '⚠' : '✘'} | ${r.scene} | ${r.step} | ${r.action} | \`${target.replace(/\|/g, '\\|')}\` | ${result.replace(/\|/g, '\\|')} |`);
  }
  // The same review as a run's (src/review.mjs): evidence per criterion, findings, the story's decisions.
  const review = def.raw && def.raw.style !== 'explainer' ? reviewOf({ raw: def.raw, steps: report, criteria: criteriaOf(def, report), firings: ran.firings ?? [], mocks: ran.mocks ?? [], passed: !blocking.length, complete: !ran.partial,
    fixtures: ran.fixtures ?? [], artifacts: ran.artifacts ?? [] }) : null;
  const warnings = [...(def.warnings ?? []), ...slides.warnings];
  if (warnings.length) lines.splice(3, 0, '', ...warnings.map(w => '⚠ ' + w));
  if (review) lines.splice(3, 0, '', `**${review.label}**${review.open ? ` · ${review.open} finding(s) to decide` : ''}`, ...review.evidence.map(e => `- AC${e.id}: ${e.strength} (${e.reasons.join('; ')})`));
  fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify({ steps: report.length, failed: failed.length, blocking: blocking.length, report, review,
    fixtures: ran.fixtures ?? [], artifacts: ran.artifacts ?? [], warnings }, null, 2));
  fs.writeFileSync(path.join(outDir, 'validation.md'), lines.join('\n') + '\n');
  console.log(lines.slice(2).join('\n'));
  return { steps: report.length, failed: failed.length, blocking: blocking.length, report: path.join(outDir, 'validation.md') };
}

/**
 * Draws the tour's slide scenes into outDir/slides/ (src/slides.mjs). Returns { files: { <scene id>: png },
 * warnings, entries } (entries: one validation line per slide). A slide that can't be drawn is a TOOLING failure.
 */
async function drawSlides(def, scenes, tourDir, outDir) {
  const todo = scenes.filter(s => s.slide && !s.offCamera);
  if (!todo.length) return { files: {}, warnings: [], entries: [] };
  let r;
  try { r = await renderSlides(todo, { outDir, dir: tourDir, style: def.slides, log }); } catch (e) {
    if (/slide image/.test(e.message)) throw new ConfigError(e.message);
    throw new Failure('tooling', `couldn't draw the slides: ${e.message}`);
  }
  const entries = todo.map(s => {
    const w = r.warnings.find(x => x.startsWith(`${s.id}:`));
    return { scene: s.id, step: '-', action: 'slide', ok: true, ...(w ? { warning: w } : {}), spec: { slide: s.slide.heading ?? s.title } };
  });
  for (const w of r.warnings) log(`warning: ${w}`);
  return { ...r, entries };
}

/**
 * The tour as it ran, in <run>/source/: tour.json plus its own files (slide images, the "pages" folder, upload files)
 * with paths rewritten into the copy, so `aft run <run>/source/tour.json` re-renders it later, wherever the original
 * was (a temp folder, another checkout). Platform files (fragments, fixtures) stay with the platform, by name.
 */
function keepSource(def, tourDir, outDir) {
  if (!def.tourFile || !/\.json$/i.test(def.tourFile)) return null;
  const src = path.join(outDir, 'source');
  const assets = path.join(src, 'assets');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(def.tourFile, 'utf8')); } catch { return null; }
  const taken = new Map();
  const copy = abs => {
    if (taken.has(abs)) return taken.get(abs);
    let name = path.basename(abs), n = 1;
    while ([...taken.values()].includes(`assets/${name}`)) name = `${path.parse(abs).name}-${++n}${path.extname(abs)}`;
    fs.mkdirSync(assets, { recursive: true });
    fs.copyFileSync(abs, path.join(assets, name));
    taken.set(abs, `assets/${name}`);
    return `assets/${name}`;
  };
  for (const s of raw.scenes ?? []) {
    if (s.slide?.image) s.slide.image = copy(path.resolve(tourDir, s.slide.image));
    for (const st of s.steps ?? []) if (st.upload) st.files = [st.files].flat().map(f => {
      const abs = path.resolve(tourDir, f);
      return fs.existsSync(abs) ? copy(abs) : f; // a platform fixture file: found by the platform again
    });
  }
  fs.mkdirSync(src, { recursive: true });
  // (Not when the run folder is inside the pages folder: that copy would contain itself.)
  const inside = (a, b) => { const r = path.relative(b, a); return !r.startsWith('..') && !path.isAbsolute(r); };
  if (def.pagesDir && !inside(outDir, def.pagesDir)) { fs.cpSync(def.pagesDir, path.join(src, 'pages'), { recursive: true }); raw.pages = 'pages'; }
  else if (def.pagesDir) raw.pages = path.relative(src, def.pagesDir).split(path.sep).join('/');
  raw.$schema = schemaRef(src, 'tour');
  const file = path.join(src, path.basename(def.tourFile));
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return file;
}

// ---- Render (narrate → record → cut → mux → join) ----------------------------------------------------------------

async function render(def, tourDir, outDir, args) {
  requireFfmpeg();
  const tail = args.tail !== undefined ? Number(args.tail) : 0.75;
  const provider = args.speech ?? (args.voice === 'silent' ? 'silent' : defaultProvider());
  const scenes = scenesOf(def, tourDir);
  fs.writeFileSync(path.join(outDir, 'script.md'), scenes.map(s => `## ${s.number}. ${s.title}\n\n${s.offCamera ? '(off camera: runs and is checked, not filmed)' : s.narration}\n`).join('\n'));

  // Off-camera scenes run (and are checked) but have no narration, clip or caption.
  const filmed = scenes.filter(s => !s.offCamera);
  for (const s of filmed) {
    s.wav = path.join(outDir, `${s.id}.wav`);
    await speak({ text: spokenText(s.narration, def.pronounce), wav: s.wav, voice: args.voice === 'silent' ? undefined : args.voice ?? def.voice,
      rate: Number(args.rate ?? 0), provider });
    s.narrationSeconds = await duration(s.wav);
    s.seconds = s.narrationSeconds + tail;
  }
  log(`narration (${provider}): ${filmed.length} scenes, ${num(filmed.reduce((a, s) => a + s.seconds, 0))} s`);
  const slides = await drawSlides(def, scenes, tourDir, outDir);
  const source = keepSource(def, tourDir, outDir);
  if (source) log(`source: ${source} (re-render with aft run on it)`);

  const clipsDir = path.resolve(args.clips ?? (args.record ? path.join(outDir, 'clips') : path.join(tourDir, 'clips', def.name)));
  // A tour of slides only has nothing to record: no browser, app or login.
  if (args.record && def.needsBrowser === false) log('slides only: nothing to record in a browser');
  else if (args.record) {
    const issues = def.raw && !args.allowDraft ? scriptIssues(def.raw) : [];
    if (issues.length)
      throw new StepError(`the script isn't ready to record (${issues.length} issue(s)):\n  ${issues.map(i => `${i.scene}: ${i.error}`).join('\n  ')}\nFix tour.json (aft validate shows them too), or pass --allow-draft to record anyway.`);
    const done = await recordWith(def, tourDir, outDir, scenes, args);
    if (done.partial) { log(`partial run (${done.partial}): report written, no video rendered`); return { partial: true }; }
    const timingsFile = path.join(outDir, 'timings.json');
    const timingsDoc = JSON.parse(fs.readFileSync(timingsFile, 'utf8'));
    const timings = timingsDoc.scenes;
    // Long waits (loads, busy indicators, dismissed known issues) are cut or sped up; the narration never is.
    const v = def.video ?? {};
    const trim = args.noTrim ? { mode: 'off' } : { mode: v.trimWaits ?? 'cut', over: Number(v.trimWaitsOver ?? 1.5), speed: Number(v.speed ?? 4), leadIn: Number(v.leadIn ?? 0.3) };
    for (const t of timings) t.trim = trimPlan(t, trim);
    await cutClips(path.join(outDir, 'recording.webm'), timings, clipsDir);
    const trimmed = timings.map(t => ({ scene: t.id, seconds: +t.trim.saved.toFixed(2), windows: t.trim.windows.length })).filter(x => x.windows);
    fs.writeFileSync(timingsFile, JSON.stringify({ ...timingsDoc, trim: { ...trim, trimmed }, scenes: timings }, null, 2));
    if (trimmed.length) {
      log(`trimmed waits (${trim.mode}): ${trimmed.map(x => `${x.scene} ${x.seconds}s`).join(', ')}`);
      noteTrim(outDir, trim, trimmed);
    }
    for (const s of filmed) {
      const t = timings.find(x => x.id === s.id);
      s.mocked = !!t?.mocked;
      s.notes = (t?.notes ?? []).map(n => ({ text: n.text, at: t.trim.map(n.at) - t.start }));
    }
  }

  const segments = [];
  for (const s of filmed) {
    const seg = await muxScene({ scene: s, clip: s.slide ? null : path.join(clipsDir, `${s.id}.mp4`), image: slides.files[s.id], outDir });
    segments.push(seg.file);
    s.length = seg.length;
  }
  const file = await concat(segments, outDir);
  if (!args.noCaptions)
    writeCaptions(filmed.map(s => ({ text: spokenText(s.narration), narrationSeconds: s.narrationSeconds, length: s.length, mocked: s.mocked, notes: s.notes })), path.join(outDir, 'tour.vtt'));
  const seconds = await duration(file);
  console.log(`Done: ${file}  (${num(seconds)} s)`);
  return { video: file, seconds: +num(seconds) };
}

/** Adds how much of each scene's waiting was trimmed to report.json ("trimmed") and report.md. */
function noteTrim(outDir, trim, trimmed) {
  try {
    const rj = path.join(outDir, 'report.json');
    const r = JSON.parse(fs.readFileSync(rj, 'utf8'));
    fs.writeFileSync(rj, JSON.stringify({ ...r, trimmed: { mode: trim.mode, over: trim.over, scenes: trimmed } }, null, 2));
    fs.appendFileSync(path.join(outDir, 'report.md'), `\n## Video\n\nWaits over ${trim.over}s ${trim.mode === 'speed' ? `sped up ${trim.speed}×` : 'cut'} (--no-trim keeps them):\n\n${trimmed.map(x => `- ${x.scene}: ${x.seconds}s (${x.windows} wait(s))`).join('\n')}\n`);
  } catch { /* the report is best effort here */ }
}

// ---- Generate (story/prompt → editable tour.json + script.md) ----------------------------------------------------

/**
 * The app's settings without a tour to run: --platform <name> (its environment and role), or --tour <tour.json>
 * (a platform tour or a stand-alone one). null when neither is given.
 */
function appSettings(args, opts) {
  try { return appSettingsFor(toolRoot, { ...args, target: envOf(args) }, opts); } catch (e) { throw e instanceof ConfigError ? new UsageError(e.message) : e; }
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
  const common = { ready: cfg.ready, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, paths: cfg.discover?.paths ?? [], errors: cfg.errors, workarounds: cfg.workarounds, timeouts: cfg.timeouts };
  if (!cfg.login) return common;
  const state = app.authFile(cfg.login.role);
  return fs.existsSync(state) ? { ...common, storageState: state } : { ...common, loginSteps: cfg.login.steps };
}

/** Discovers (when there's a URL), plans into out, and merges login/environments/hooks/mask from --tour. */
async function generateInto(out, args, { url, story, name }) {
  const discovery = url
    ? await discover({ url, outDir: out, maxPages: Number(args.maxPages ?? 12), include: args.include, exclude: args.exclude, ...loginStepsFor(args) })
    : null;
  // What was learned about the app before (accounts, setup recipes, findings): context for the planner.
  const platformDir = appSettings(args)?.platform?.dir;
  const notes = platformDir ? notesForPrompt(readNotes(platformDir)) : [];
  if (notes.length && args.llm) log(`platform notes for the planner: ${notes.map(n => n.file).join(', ')}`);
  const tour = await plan({ discovery, outDir: out, name: safeName(name), prompt: args.prompt, story, style: args.style, llm: args.llm, model: args.model,
    maxScenes: Number(args.maxScenes ?? 6), baseUrl: url ? undefined : args.baseUrl, notes });
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

/** The definition type a file name implies (tour, platform, environments, login, fragment, fixture), or null. */
function definitionType(file) {
  const b = path.basename(file), d = path.basename(path.dirname(path.resolve(file)));
  if (/\.tour\.json$/.test(b)) return 'tour';
  if (['platform.json', 'environments.json', 'login.json'].includes(b)) return b.replace('.json', '');
  if (d === 'fragments' && b.endsWith('.json')) return 'fragment';
  if (d === 'fixtures' && b.endsWith('.json')) return 'fixture';
  if (d === 'mocks' && b.endsWith('.json')) return 'mocks';
  return b.endsWith('.json') ? 'tour' : null;
}

// ---- Sessions ----------------------------------------------------------------------------------------------------

/** The running session to use: --session <name>, else the only ready one (for --platform/--target if given). */
function pickSession(args, { required = false } = {}) {
  const live = readSessions(toolRoot).filter(s => s.alive && s.status === 'ready');
  if (args.session) {
    const s = live.find(x => x.name === args.session);
    if (!s && required) throw new UsageError(`No running session "${args.session}" (running: ${live.map(x => x.name).join(', ') || 'none'})`);
    return s ?? null;
  }
  // A stage (aft stage) is only used when named: it is someone's hand-off, not a scratch page.
  const match = live.filter(s => !s.stage && (!args.platform || s.platform === args.platform) && (!envOf(args) || s.env === envOf(args)) && (!args.role || s.role === args.role));
  if (match.length === 1) return match[0];
  if (match.length > 1) throw new UsageError(`Several sessions match (${match.map(s => s.name).join(', ')}): pick one with --session <name>`);
  if (required) throw new UsageError('No running session: aft session start --platform <name>');
  return null;
}

/** Runs fn on the matching live session, or on a one-shot session started (and stopped) just for this command. */
async function withSession(args, fn) {
  const s = args.platform || args.session || args.tour || !(args.baseUrl || process.env.BASE_URL) ? pickSession(args) : null;
  if (s) { log(`using session ${s.name}`); return fn(s, true); }
  const app = appSettings(args, { allowBareUrl: true });
  if (!app) throw new UsageError('Name the app: --platform <name> [--target <env>] (or --base-url <url>), or start a session first: aft session start --platform <name>');
  const outDir = newRunDir(path.join(path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out')), 'sessions', 'one-shot'));
  log(`no running session: opening a one-shot browser (${outDir})`);
  const session = new Session({ app, outDir, headed: !!args.headed, log, options: { freshLogin: args.freshLogin, env: envOf(args) } });
  try { await session.start(); return await fn(session, false); } finally { await session.stop(); }
}

// ---- Conversations (generate --converse, aft converse: src/converse.mjs) ------------------------------------------

const PRODUCTION = /^(prod|production|live)(\b|[-_])/i;

/** The conversation's one live browser: a stage (src/stage.mjs) built from the draft tour.json in its run folder. */
function conversationStage(runDir, conv, args) {
  const name = conv.stageName;
  const current = () => readSessions(toolRoot).find(s => s.name === name);
  const undoDead = async dir => commands.cleanup({ _: ['cleanup', dir] }).catch(e => ({ error: e.message.split('\n')[0] }));
  const start = async point => {
    const outDir = newRunDir(path.join(runDir, 'stages'));
    log(`stage ${name}: ${describePoint(point)} (${outDir})`);
    const s = await startStage({ toolRoot, name, outDir, echo: text => process.stderr.write(text),
      job: { file: path.join(runDir, 'tour.json'), sourceRun: runDir, point, keep: false,
        args: { target: conv.env ?? undefined, role: conv.role ?? undefined, headless: args.headed ? false : !!(args.headless || conv.headless), freshLogin: !!args.freshLogin } } });
    if (s.status === 'failed') fs.rmSync(path.join(sessionsDir(toolRoot), `${name}.json`), { force: true });
    conv.stageRuns = [...(conv.stageRuns ?? []), outDir];
    return stageView({ ...s, alive: s.status === 'ready' });
  };
  return {
    alive: () => !!current()?.alive,
    async ensure() {
      const s = current();
      if (s?.alive) return stageView(s);
      if (s) await endStage(toolRoot, s, { keep: false, undoDead });
      return start({ setupOnly: true });
    },
    async call(op, params) {
      let s = current();
      if (!s?.alive) { await this.ensure(); s = current(); }
      if (!s?.alive || !s.port) throw new Failure('error', `the conversation's stage (${name}) has no browser: it failed to start; see ${conv.stageRuns?.at(-1) ?? runDir}`);
      return call(s, op, params);
    },
    async redo(point) {
      const s = current();
      if (s) await endStage(toolRoot, s, { keep: false, undoDead });
      return start(point);
    },
    async end({ keep = false } = {}) {
      const s = current();
      return s ? endStage(toolRoot, s, { keep, undoDead }) : null;
    },
  };
}

/** What a conversation needs from outside: Claude (or a scripted agent for tests), the stage, validate. */
function conversationDeps(runDir, conv, args) {
  const fake = process.env.AFT_FAKE_AGENT;   // tests: a JSON file with the agent's replies, in order
  const ask = fake
    ? async () => {
      const replies = JSON.parse(fs.readFileSync(fake, 'utf8'));
      const n = conv.fakeTurn = (conv.fakeTurn ?? 0) + 1;
      return { output: replies[n - 1] ?? { say: '(no more scripted replies)', done: true }, sessionId: 'fake-session' };
    }
    : ({ system, input, schema, resume }) => claude({ system, input, schema, resume, cwd: runDir, model: args.model, session: true });
  const validateDraft = async file => {
    const out = newRunDir(path.join(runDir, 'validations'));
    const { spawn } = await import('node:child_process');
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'validate', file, '--json', '--out', out, ...(args.headed ? ['--headed'] : [])],
      { windowsHide: true, cwd: process.cwd(), env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => process.stderr.write(d));
    await new Promise(ok => p.on('close', ok));
    let doc = null;
    try { doc = JSON.parse(stdout); } catch { /* below */ }
    const vj = path.join(out, 'validation.json');
    const v = fs.existsSync(vj) ? JSON.parse(fs.readFileSync(vj, 'utf8')) : null;
    if (!v) throw Object.assign(new Error(`validate didn't finish: ${doc?.error?.message ?? 'no validation.json'}`), { failure: doc?.class });
    return { blocking: v.blocking, report: v.report, runDir: out };
  };
  return { ask, stage: conversationStage(runDir, conv, args), validate: validateDraft, log: text => log(text) };
}

/** One command at a time on a conversation: a lock file with the pid. */
function lockConversation(runDir) {
  const f = path.join(runDir, '.converse.lock');
  if (fs.existsSync(f)) {
    const pid = Number(fs.readFileSync(f, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive && pid !== process.pid) throw new UsageError(`the conversation in ${runDir} is busy (aft converse, pid ${pid}): wait for it`);
  }
  fs.writeFileSync(f, String(process.pid));
  return () => fs.rmSync(f, { force: true });
}

/** Platform names a conversation can use: fragments (with parameters) and fixtures (with data keys). */
function platformParts(app) {
  const dir = app?.platform?.dir;
  const list = (sub, fn) => (dir && fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter(f => /\.(json|mjs)$/.test(f)).map(f => fn(f, path.join(dir, sub, f))) : []);
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  return {
    fragments: list('fragments', (f, p) => ({ name: f.replace(/\.(json|mjs)$/, ''), ...(f.endsWith('.json') ? { params: read(p).params ?? {}, comment: read(p).comment } : { code: true }) })),
    fixtures: list('fixtures', (f, p) => (f.endsWith('.json') ? { name: f.replace(/\.json$/, ''), data: Object.keys(read(p).data ?? {}), comment: read(p).comment } : null)).filter(Boolean),
  };
}

const printConversation = r => {
  if (json) return;
  if (r.say) console.log(`\nagent: ${r.say}`);
  for (const s of r.scenes ?? []) console.log(`  ${String(s.index).padStart(2)}. [${s.state}] ${s.title} (${s.steps} step(s)${s.untried ? `, ${s.untried} not tried` : ''})${s.todo ? `  todo: ${s.todo.slice(0, 100)}` : ''}`);
  for (const q of r.questions ?? []) console.log(`  ? ${q.id} (${q.type}${q.scene ? `, scene ${q.scene}` : ''}): ${q.text}${q.options?.length ? `  [${q.options.map(o => o.value).join(' | ')}]` : ''}`);
  for (const p of r.proposals ?? []) console.log(`  proposal ${p.id} (${p.kind}): ${p.why}  (--accept ${p.id} / --reject ${p.id})`);
  console.log(`\nstate: ${r.state}${r.finished ? ' (finished)' : ''}  ·  ${r.tour}`);
  if (r.state === 'waiting' && r.questions?.length) console.log(`answer: aft converse "${r.runDir}" --answer ${r.questions[0].id}=<value>  (or --say "…")`);
  if (r.state === 'recording') console.log(`recording scene ${r.recording.scene}: act in the browser, then  aft converse "${r.runDir}" --stop`);
  if (r.state === 'done' && !r.finished) console.log(`next: aft converse "${r.runDir}" --finish  (validates, writes the tour, ends the stage)`);
};

async function startConversation(args, story) {
  if (args.llm !== 'claude' && !process.env.AFT_FAKE_AGENT) throw new UsageError('--converse needs --llm claude (the agent that explores the app)');
  if (!story) throw new UsageError('--converse needs a --story');
  const app = appSettings(args);
  if (!app?.platform) throw new UsageError('--converse needs --platform <name>: the conversation stages the platform\'s app to explore it');
  const env = app.env ?? envOf(args) ?? null;
  if (env && PRODUCTION.test(env)) throw new UsageError(`--converse probes the app for real (it clicks, types and creates data): not on "${env}"; use a local or test environment`);
  const name = safeName(args.name ?? storyName(story));
  return withRun(name, args, 'generate', async runDir => {
    const conv = Object.assign(newConversation({ story, platform: app.platform.name, env, role: args.role ?? null, style: args.style,
      stageName: `stage-conv-${safeName(name).slice(0, 30)}-${path.basename(runDir).slice(-4)}`, limit: Number(args.probeBudget ?? 80) }), { name, ...(args.headless ? { headless: true } : {}) });
    writeDraft(runDir, conv);
    saveConversation(runDir, conv);
    const url = targetUrl(args);
    const discovery = url && !args.noDiscover
      ? await discover({ url, outDir: runDir, maxPages: Number(args.maxPages ?? 8), include: args.include, exclude: args.exclude, ...loginStepsFor(args) }).catch(e => { log(`discovery failed (${e.message.split('\n')[0]}); the agent explores without an inventory`); return null; })
      : null;
    const deps = conversationDeps(runDir, conv, args);
    const release = lockConversation(runDir);
    try {
      const stage = await deps.stage.ensure();
      saveConversation(runDir, conv);
      if (stage.state === 'failed') log(`the stage failed (${stage.error}): the agent is told; the setup may need fixing`);
      const r = await turn(runDir, conv, { kind: 'start', story, style: args.style ?? null, platform: app.platform.name, env, role: conv.role, ...platformParts(app),
        inventory: discovery ? inventoryFor(discovery) : [], stage: { state: stage.state, reached: stage.reached, url: stage.url, error: stage.error, warnings: stage.warnings },
        ask: 'Plan one scene per acceptance criterion. Explore the live app to find each one\'s steps (snapshot, locate, tryStep), write the steps that worked, and ask the person what only they can decide.' }, deps);
      printConversation(r);
      return { ...r, conversation: true };
    } finally { release(); }
  });
}

// ---- Commands ----------------------------------------------------------------------------------------------------

const commands = {
  /** The local web UI: runs ui/server.mjs in the foreground with this command's flags, until it is stopped. */
  async ui() {
    const server = path.join(toolRoot, 'ui', 'server.mjs');
    if (!fs.existsSync(server)) throw new UsageError(`no UI in this install (${server})`);
    const raw = process.argv.slice(process.argv.indexOf('ui') + 1).filter(a => a !== '--json');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [server, ...raw], { windowsHide: true, stdio: 'inherit' });
    let stopping = false;   // stopped on purpose (Ctrl+C, a kill): not an error
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; child.kill(sig); });
    const code = await new Promise(ok => child.on('close', (c, sig) => ok(sig ? 0 : c)));
    if (code && !stopping && code !== 130 && code !== 143) throw new UsageError(`the UI server exited with code ${code}`);
    return null;
  },

  async doctor(args) {
    const r = await doctor({ toolRoot, platform: args.platform ?? args.target, quiet: !!args.json });
    if (!r.ok) { lastData = r; throw Object.assign(new UsageError(`${r.checks.filter(c => c.required && !c.ok).length} required item(s) missing`), { data: r }); }
    return r;
  },

  async generate(args) {
    if (args.from) return generateExplainer(args);
    const story = readStory(args.story);
    if (args.converse) return startConversation(args, story);
    const url = targetUrl(args);
    if (!story && !args.prompt) throw new UsageError('Usage: aft generate --story <file|text> [--base-url <url>] [--llm claude] [--style ...]');
    return withRun(args.name ?? storyName(story, url), args, 'generate', async out => {
      const { tour, tourFile } = await generateInto(out, args, { url, story, name: args.name ?? storyName(story, url) });
      log(`next: review/edit it, then  aft validate "${tourFile}"  and  aft run "${tourFile}"`);
      return { tour: tourFile, scenes: tour.scenes.length, draft: !!tour.draft };
    });
  },

  /** Continue a conversation (src/converse.mjs): say, answer, record, accept a proposal, finish, end. */
  async converse(args) {
    const runDir = args._[1] && path.resolve(args._[1]);
    if (!runDir || !fs.existsSync(path.join(runDir, 'conversation.json')))
      throw new UsageError('Usage: aft converse <conversation run folder> [--say "…"] [--answer q3=Approve ...] | --record N [--after-step J] | --steps [--drop-last] | --stop | --accept p1 | --reject p1 | --finish [--force] | --end [--keep]');
    lastRunDir = runDir;
    // The steps recorded so far: read-only, polled while recording, so it never takes the lock (a STOP must get it).
    if (args.steps) {
      const conv = readConversation(runDir);
      if (!conv.recording) return { ...conversationView(runDir, conv), recorded: [] };
      const r = await recordedSteps(conversationDeps(runDir, conv, args), { dropLast: !!args.dropLast });
      if (!json) for (const [i, s] of (r.steps ?? []).entries()) console.log(`${String(i + 1).padStart(2)}. ${JSON.stringify(s.step)}${s.weak ? '  (weak)' : ''}`);
      return { ...conversationView(runDir, conv), recorded: r.steps ?? [] };
    }
    const release = lockConversation(runDir);
    try {
      const conv = readConversation(runDir);
      const deps = conversationDeps(runDir, conv, args);
      const done = r => { saveConversation(runDir, conv); printConversation(r); return r; };
      if (args.stop) return done(await stopRecording(runDir, conv, deps));
      if (args.end) {
        if (conv.recording) await deps.stage.call('record-stop', {}).catch(() => {});
        delete conv.recording;
        const ended = await deps.stage.end({ keep: !!args.keep });
        conv.ended = true;
        if (conv.state !== 'done') conv.state = 'failed';
        conv.turns.push({ who: 'person', at: new Date().toISOString(), text: `ended the conversation${args.keep ? ' (data kept)' : ''}` });
        return done({ ...conversationView(runDir, conv), stageEnded: ended });
      }
      for (const id of [args.accept ?? []].flat().filter(x => x !== true)) decideProposal(conv, String(id), true);
      for (const id of [args.reject ?? []].flat().filter(x => x !== true)) decideProposal(conv, String(id), false);
      if (args.accept || args.reject) { writeDraft(runDir, conv); if (!args.say && !args.answer && !args.finish) return done(conversationView(runDir, conv)); }
      if (args.finish) {
        if (args.say || args.answer) throw new UsageError('--finish goes alone (say or answer first)');
        return done(await finish(runDir, conv, deps, { force: !!args.force }));
      }
      if (args.record !== undefined) {
        const scene = Number(args.record), afterStep = args.afterStep !== undefined ? Number(args.afterStep) : undefined;
        try { return done(await startRecording(runDir, conv, { scene, afterStep }, deps)); } catch (e) { if (e.failure) throw e; throw new UsageError(e.message); }
      }
      if (!args.say && !args.answer) return done(conversationView(runDir, conv));
      if (conv.recording) throw new UsageError(`recording scene ${conv.recording.scene}: --stop first`);
      let answers, effects;
      try { answers = parseAnswers(args.answer); effects = applyAnswers(conv, answers); } catch (e) { throw new UsageError(e.message); }
      const say = args.say === true ? '' : String(args.say ?? '');
      conv.turns.push({ who: 'person', at: new Date().toISOString(), text: say, ...(Object.keys(answers).length ? { answers } : {}) });
      if (effects.restage) { writeDraft(runDir, conv); await deps.stage.redo({ setupOnly: true }); }
      if (effects.record) {
        // The answers reach the agent with the recorded steps.
        conv.pending = { say, answers };
        return done(await startRecording(runDir, conv, effects.record, deps));
      }
      const earlier = conv.pending;
      delete conv.pending;
      return done(await turn(runDir, conv, { kind: 'message', say, answers, ...(earlier ? { earlier } : {}) }, deps));
    } finally { release(); }
  },

  async validate(args) {
    const file = args.script ?? args._[1];
    const type = file && definitionType(file);
    // Any definition file, schema only (no app): a tour with --schema-only, or a platform/environments/login/fragment/fixture file.
    if (type && (type !== 'tour' || args.schemaOnly)) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(`${file}: not valid JSON (${e.message})`); }
      const problems = checkSchema(type, doc);
      for (const p of problems) console.log(`✘ ${p}`);
      if (problems.length) { lastData = { file, type, problems }; throw new ConfigError(`${file} doesn't match the ${type} schema (${problems.length} problem(s))`); }
      console.log(`✔ ${file} matches schemas/${type}.schema.json`);
      return { file, type, problems: [] };
    }
    const { def, dir } = await loadTour(file, args);
    if (args.reset) await commands.reset({ ...args, _: ['reset'], platform: def.platform, tour: file, target: envOf(args) ?? def.env, name: undefined });
    const r = await withRun(runName(def, args), args, 'validate', out => validate(def, dir, out, args));
    if (r.blocking) { lastData = r; throw new StepError(`${r.blocking} step(s) can't be resolved; see validation.md in the run folder`); }
    return r;
  },

  async run(args) { return commands.render({ ...args, record: true }); },

  async render(args) {
    const { def, dir } = await loadTour(args.script ?? args._[1], args);
    if (args.reset) await commands.reset({ ...args, _: ['reset'], platform: def.platform, tour: args.script ?? args._[1], target: envOf(args) ?? def.env, name: undefined });
    return withRun(runName(def, args), args, args.record ? 'run' : 'render', out => render(def, dir, out, args));
  },

  async all(args) {
    const story = readStory(args.story);
    const url = targetUrl(args);
    if (!url) throw new UsageError('aft all needs the app: --base-url <url> (or BASE_URL). Example: aft all --story story.md --base-url https://qa.example.com/ --llm claude [--tour app.tour.json for login/hooks]');
    const name = args.name ?? storyName(story, url);
    let blocking = 0;
    const r = await withRun(name, args, 'all', async out => {
      const { tour, tourFile } = await generateInto(out, args, { url, story, name });
      if (tour.draft) throw new StepError(`the generated script is a draft and wasn't recorded: edit ${tourFile}, then aft validate / aft run it`);
      const def = loadTourJson(tourFile, { env: envOf(args), baseUrl: args.baseUrl, role: args.role, toolRoot });
      const v = await validate(def, out, out, args);
      blocking = v.blocking;
      if (blocking) return { tour: tourFile, validation: v.report, blocking };
      // The dry run used its own browser session; the recording starts fresh.
      return { tour: tourFile, ...(await render(def, out, out, { ...args, record: true })) };
    });
    if (blocking) { lastData = r; throw new StepError(`${blocking} step(s) can't be resolved; fix tour.json (see validation.md), then aft run it`); }
    return r;
  },

  async discover(args) {
    const url = args._[1] ?? args.baseUrl;
    if (!url) throw new UsageError('Usage: aft discover <url>');
    return withRun(args.name ?? new URL(url).hostname, args, 'discover', async out => {
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
    return withRun(name, args, 'plan', async out => {
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
    return withRun(name, args, 'auto', async out => {
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
    if (!app.cfg.baseUrl) throw new UsageError(`${app.name}: no baseUrl for environment ${app.env ?? '(none)'}`);
    const missing = args.manual ? [] : missingCredentials(app.cfg.login?.steps);
    if (missing.length) throw new Failure('login', `can't sign in: credentials missing: ${missing.join(', ')}`);
    // Fill {env:NAME} (credentials) as a run does; the step runner never sees placeholders.
    const { cfg } = await materialize(app.cfg);
    const state = await saveLogin({ baseUrl: cfg.baseUrl, steps: cfg.login?.steps, file: app.authFile(cfg.login?.role), manual: !!args.manual, viewport: cfg.viewport,
      timeouts: cfg.timeouts, ready: cfg.ready, ignoreHTTPSErrors: cfg.ignoreHTTPSErrors, signedIn: cfg.login?.signedIn, workarounds: cfg.workarounds });
    return { platform: app.platform?.name ?? null, env: app.env ?? null, role: cfg.login?.role ?? null, state };
  },

  async 'suggest-fix'(args) {
    const dir = args._[1];
    if (!dir || !fs.existsSync(path.join(dir, 'run.json')) || !args.finding)
      throw new UsageError('Usage: aft suggest-fix <run folder> --finding "<id>" [--llm claude] [--model <m>]  (ids: report.json / validation.json review.findings)');
    if ((args.llm ?? 'claude') !== 'claude') throw new UsageError('suggest-fix needs --llm claude');
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    return withRun(run.name ?? path.basename(path.dirname(path.resolve(dir))), args, 'suggest-fix',
      out => suggestFix({ runDir: path.resolve(dir), finding: String(args.finding), outDir: out, model: args.model }));
  },

  /** Finishes the undo runs left pending (crash, Ctrl+C, a failed teardown). Without a run, --all, --platform or --tag: lists them. */
  async cleanup(args) {
    const outRoot = path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out'));
    const olderThanMs = args.olderThan !== undefined ? parseAge(args.olderThan) : null;
    if (args.olderThan !== undefined && !olderThanMs) throw new UsageError(`--older-than takes an age like 2d, 12h or 30m (got "${args.olderThan}")`);
    let found;
    if (args._[1]) {
      const dir = path.resolve(args._[1]);
      const file = path.join(dir, 'ledger.json');
      if (!fs.existsSync(file)) throw new UsageError(`${dir} has no ledger.json (only runs of this version record what they set up)`);
      const ledger = Ledger.read(file);
      found = ledger.pending({ retryFailed: true }).length ? [{ dir, file, ledger }] : [];
    } else found = openLedgers(outRoot, { platform: args.platform, env: envOf(args), tag: args.tag, olderThanMs });
    const pending = found.map(f => ({ run: f.dir, tour: f.ledger.doc.tour, platform: f.ledger.doc.platform ?? null, env: f.ledger.doc.env ?? null, tag: f.ledger.doc.tag ?? null,
      startedAt: f.ledger.doc.startedAt, items: f.ledger.pending({ retryFailed: true }).map(i => ({ name: i.name, kind: i.kind, status: i.status, undo: i.undo.steps ? 'browser steps' : 'hooks' })) }));
    for (const p of pending) console.log(`${p.run}\n${p.items.map(i => `  ${i.status.padEnd(11)} ${i.name} (${i.undo})`).join('\n')}`);
    if (!pending.length) { console.log('nothing to clean up'); return { pending: [], cleaned: [] }; }
    if (args.dryRun || (!args._[1] && !args.all && !args.platform && !args.tag)) {
      console.log(`\n${pending.length} run(s) with undo pending. Run them: aft cleanup --all (or a run folder, --platform <name>, --tag <prefix>)`);
      return { pending, cleaned: [] };
    }
    // Browser steps need a signed-in browser: a one-shot session for that run's platform, environment and role.
    const openBrowser = async d => {
      const app = appSettingsFor(toolRoot, d.platform ? { platform: d.platform, target: d.env ?? undefined, role: d.role ?? undefined } : { tour: d.tourFile });
      const session = new Session({ app, outDir: newRunDir(path.join(outRoot, 'sessions', 'cleanup')), log, options: {} });
      await session.start();
      return { undoSteps: steps => runSteps(session.tour, steps, { ...session.stepOpts(null), scene: 'cleanup' }), close: () => session.stop() };
    };
    const cleaned = await finishUndo(found, { log, openBrowser });
    const failed = cleaned.reduce((n, r) => n + r.failed + r.left, 0);
    console.log(`\ncleaned ${cleaned.length} run(s): ${cleaned.reduce((n, r) => n + r.undone, 0)} undone, ${failed} still pending`);
    if (failed) throw Object.assign(new UsageError(`${failed} undo step(s) failed or couldn't run; see each run's ledger.json`), { data: { pending, cleaned } });
    return { pending, cleaned };
  },

  /** Several tours in order, one environment reset first; each tour runs through the normal run path (a child aft). */
  async batch(args) {
    if (args.out || args.name) throw new UsageError('aft batch writes to out/batch/<run>/; --out and --name are not supported');
    const files = (() => { try { return expandTours(args._.slice(1)); } catch (e) { throw e.usage ? new UsageError(e.message) : e; } })();
    if (!files.length) throw new UsageError('Usage: aft batch <tour.json | folder | glob>... [--target <env>] [--reset] [--validate-only] [--stop-on-fail]');
    const tours = [];
    for (const file of files) { const { def } = await loadTour(file, args); tours.push({ file, name: def.name ?? path.basename(file), platform: def.platform, env: envOf(args) ?? def.env }); }
    let reset = null;
    if (args.reset) {
      const keys = [...new Set(tours.map(t => `${t.platform ?? '(no platform)'} / ${t.env ?? '(default)'}`))];
      if (keys.length > 1 || !tours[0].platform) throw new UsageError(`--reset needs every tour on one platform and environment; these use ${keys.join(', ')}`);
      const r = await commands.reset({ ...args, _: ['reset'], platform: tours[0].platform, tour: files[0], target: tours[0].env, name: undefined });
      reset = { platform: tours[0].platform, env: tours[0].env ?? null, result: { runDir: r.runDir } };
    } else if (new Set(tours.map(t => t.platform)).size === 1) reset = { platform: tours[0].platform, env: tours[0].env ?? null };
    const dir = newRunDir(path.join(path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out')), 'batch'));
    lastRunDir = dir;
    log(`batch folder: ${dir}`);
    batchState = { stop: false, child: null };
    let doc;
    try { doc = await runBatch({ tours, args, cliPath: fileURLToPath(import.meta.url), dir, reset, log, state: batchState }); } finally { batchState = null; }
    console.log(fs.readFileSync(path.join(dir, 'batch.md'), 'utf8'));
    if (doc.exitCode) {
      const first = doc.tours.find(t => t.exitCode);
      lastData = doc;
      throw Object.assign(new Error(doc.exitCode === 130 ? 'batch interrupted' : `${doc.counts.failed} of ${doc.tours.length} tour(s) failed; first: ${first.name} (${first.class}): ${first.error ?? ''}`),
        { failure: doc.exitCode === 130 ? 'interrupted' : first.class, data: doc });
    }
    return doc;
  },

  /** An environment's "reset" hooks (local only; never a shared environment). */
  async reset(args) {
    const app = appSettings(args);
    if (!app?.platform) throw new UsageError('Usage: aft reset --platform <name> [--target <env>]');
    const { cfg, vars } = await materialize(app.cfg);
    return withRun(`${app.platform.name}-reset`, args, 'reset', out => resetEnvironment(cfg, { env: app.env, dir: app.platform.dir, outDir: out, baseUrl: vars.baseUrl, log })
      .catch(e => { throw e.failure === 'error' ? new UsageError(e.message) : e; }));
  },

  async export(args) {
    const src = args._[1] ?? args.script;
    if (!src || !fs.existsSync(src)) throw new UsageError('Usage: aft export <tour.json | run folder> [--out <folder>]  (writes <run>/<name>.aft.json)');
    const { doc, name } = exportTour(src, { toolRoot, outRoot: path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out')) });
    return withRun(name, args, 'export', async out => {
      const file = path.join(out, `${safeName(name)}.aft.json`);
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      const last = doc.source.last;
      log(`exported ${name} from ${doc.source.platform ?? 'a stand-alone tour'}${doc.source.env ? ` (${doc.source.env})` : ''}${last ? `, last ${last.command} ${last.result ?? last.status}` : ', no run of it found'}: ${file}`);
      if (!last) log('warning: no successful run or validation of this tour was found; the import will carry no evidence that it worked here');
      if (!args.json) console.log(`${file}\n  on the other machine: aft import "${path.basename(file)}" --platform <their platform>`);
      return { file, name, source: doc.source, requires: doc.requires, files: Object.keys(doc.files), notes: doc.notes.map(n => n.file) };
    });
  },

  async import(args) {
    const file = args._[1];
    if (!file || !args.platform) throw new UsageError('Usage: aft import <file.aft.json> --platform <name> [--name <tour name>] [--force]');
    const r = importTour(path.resolve(file), { toolRoot, platform: args.platform, name: args.name, force: !!args.force });
    const rel = path.relative(process.cwd(), r.tour);
    for (const m of r.missing) log(`missing on ${args.platform}: ${m}`);
    for (const f of r.notes.written) log(`notes: ${path.relative(process.cwd(), f)}`);
    for (const f of r.notes.kept) log(`notes: kept ${path.relative(process.cwd(), f)} (an earlier import; --force replaces it)`);
    if (r.notes.newFindings.length) log(`findings ${args.platform}'s own notes don't have yet: ${r.notes.newFindings.map(f => `${f.id}${f.title ? ` (${f.title})` : ''}`).join(', ')}`);
    if (!args.json) {
      console.log(`✔ ${rel}${r.files.length ? ` (+ ${r.files.length} file(s))` : ''}`);
      if (r.missing.length) console.log(`  before it can run here, add: ${r.missing.join('; ')}`);
      console.log(`  next: aft validate ${rel}   then: aft run ${rel}`);
    }
    return { ...r, ready: !r.missing.length };
  },

  async platform(args) {
    return platformCommand(args, { toolRoot, commands, appSettings, loginStepsFor, withRun, UsageError, envOf });
  },

  /**
   * `aft scratch [<name>] [--from doc.md] [--pages] [--force]`: the official place for one-off tours (an explainer, an
   * experiment): scratch/<name>/<name>.tour.json in this checkout, git-ignored, kept across sessions, with a working
   * "$schema". No name: lists them. --from: slides from a document's outline (its images copied into assets/);
   * --pages: also a pages/ folder of static HTML, served for each run.
   */
  async scratch(args) {
    const root = path.join(toolRoot, 'scratch');
    const name = args._[1];
    if (!name) {
      const list = fs.existsSync(root) ? fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, `${d}.tour.json`)))
        .map(d => ({ name: d, tour: path.join(root, d, `${d}.tour.json`), modified: fs.statSync(path.join(root, d, `${d}.tour.json`)).mtime.toISOString() })) : [];
      if (!json) for (const t of list) console.log(`${t.name.padEnd(32)} ${t.modified.slice(0, 16).replace('T', ' ')}  ${t.tour}`);
      if (!json && !list.length) console.log('no scratch tours yet: aft scratch <name> [--from doc.md] [--pages]');
      return { scratch: list };
    }
    if (safeName(name) !== name) throw new UsageError(`scratch names are letters, digits, - and _ (try "${safeName(name)}")`);
    const dir = path.join(root, name);
    const tourFile = path.join(dir, `${name}.tour.json`);
    if (fs.existsSync(tourFile) && !args.force) throw new UsageError(`${tourFile} exists; edit it, or pass --force to start over`);
    fs.mkdirSync(dir, { recursive: true });
    let scenes;
    if (args.from) {
      const docFile = path.resolve(String(args.from));
      if (!fs.existsSync(docFile)) throw new UsageError(`--from ${args.from}: no such file`);
      ({ scenes } = outline(fs.readFileSync(docFile, 'utf8'), { dir: path.dirname(docFile), maxScenes: Number(args.maxScenes ?? 12) }));
      for (const s of scenes) if (s.slide.image) {
        fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
        const to = path.join(dir, 'assets', path.basename(s.slide.image));
        fs.copyFileSync(s.slide.image, to);
        s.slide.image = `assets/${path.basename(to)}`;
      }
    } else scenes = [
      { title: name, narration: `This is ${name}.`, slide: { heading: name, subtitle: 'What this video explains' } },
      { title: 'The point', narration: 'Say what each slide shows, in a few spoken sentences.', slide: { bullets: ['One point per bullet', 'Short enough to read while it is said'] } },
    ];
    const tour = { $schema: schemaRef(dir, 'tour'), name, style: 'explainer', scenes };
    if (args.pages) {
      fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
      const page = path.join(dir, 'pages', 'index.html');
      if (!fs.existsSync(page)) fs.writeFileSync(page, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${name}</title></head>\n<body style="font: 32px system-ui; padding: 60px">\n  <h1>${name}</h1>\n  <p>Any static page: a mock-up, a diagram, a report. Tour steps act on it like on an app.</p>\n</body></html>\n`);
      tour.pages = 'pages';
      tour.scenes.push({ title: 'A page', narration: 'Pages are recorded in the browser, with the cursor and checks.', url: 'index.html', steps: [{ point: { role: 'heading', name } }, { verify: { role: 'heading', name } }] });
    }
    fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2) + '\n');
    if (!json) console.log(`wrote ${tourFile}\nnext: edit it, then  aft render "${tourFile}"  (preview)  or  aft run "${tourFile}"`);
    return { tour: tourFile, dir, scenes: tour.scenes.length };
  },

  async schema(args) {
    const type = args._[1];
    if (!type) {
      const list = schemaTypes().map(t => ({ type: t, file: `${schemasDir}/${t}.schema.json`.replace(/\\/g, '/'), id: schemaFor(t).$id, title: schemaFor(t).title }));
      if (!args.json) for (const l of list) console.log(`${l.type.padEnd(13)} ${l.title}\n              ${l.file}`);
      return { schemas: list, common: schemaFor('common').$id };
    }
    let s;
    try { s = schemaFor(type); } catch (e) { throw new UsageError(e.message); }
    // --write <folder>: a copy beside files kept outside the checkout (a temp folder, another repo).
    if (args.write) {
      const dir = path.resolve(args.write === true ? '.' : String(args.write));
      const ref = writeSchemaCopy(dir, type);
      if (!args.json) console.log(`wrote ${path.join(dir, '.aft-schemas')}; in a file in ${dir}: "$schema": "${ref}"`);
      return { dir: path.join(dir, '.aft-schemas'), $schema: ref };
    }
    // The schema itself, plus the shared definitions it refers to, so one call gives the whole format.
    const out = { ...s, $defs: { ...(s.$defs ?? {}) }, 'x-common': schemaFor('common') };
    if (!args.json) console.log(JSON.stringify(out, null, 2));
    return out;
  },

  async session(args) {
    const sub = args._[1] ?? 'status';
    if (sub === 'status') {
      const list = readSessions(toolRoot).filter(s => !args.session || s.name === args.session);
      const out = [];
      for (const s of list) {
        let live = null;
        if (s.alive && s.status === 'ready') live = await call(s, 'status').catch(e => ({ error: e.message }));
        out.push({ name: s.name, status: s.alive ? s.status : 'dead', pid: s.pid, platform: s.platform, env: s.env, role: s.role, url: live?.url ?? s.url,
          services: s.services, log: s.log });
        if (!s.alive) fs.rmSync(path.join(sessionsDir(toolRoot), `${s.name}.json`), { force: true }); // stale
      }
      if (!args.json) for (const s of out) console.log(`${s.name.padEnd(28)} ${String(s.status).padEnd(8)} pid ${s.pid}  ${s.url ?? ''}`);
      if (!args.json && !out.length) console.log('no sessions');
      return { sessions: out };
    }
    if (sub === 'start') {
      const app = appSettings(args, { allowBareUrl: true });
      if (!app) throw new UsageError('Usage: aft session start --platform <name> [--target <env>] [--role <r>]  (or --base-url <url>)');
      const name = sessionName(app, args);
      const outDir = newRunDir(path.join(path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out')), 'sessions', name));
      log(`session ${name}: starting (log: ${path.join(outDir, 'session.log')})`);
      const s = await startDaemon({ toolRoot, name, outDir, args: { ...args, json: undefined, _: [] } });
      log(`session ${name}: ${s.reused ? 'already running' : 'ready'} (pid ${s.pid}) at ${s.url}`);
      const { token, ...shown } = s;
      return shown;
    }
    if (sub === 'stop') {
      const list = readSessions(toolRoot).filter(s => args.all || s.name === (args.session ?? pickSession(args, { required: true }).name));
      const stopped = [];
      for (const s of list) {
        const r = s.alive ? await call(s, 'stop').catch(e => ({ error: e.message })) : { note: 'was not running' };
        fs.rmSync(path.join(sessionsDir(toolRoot), `${s.name}.json`), { force: true });
        log(`session ${s.name}: stopped${r.servicesStopped?.length ? ` (and ${r.servicesStopped.join(', ')}, which it started)` : ''}`);
        stopped.push({ name: s.name, ...r });
      }
      return { stopped };
    }
    if (sub === 'wait') {
      const s = pickSession(args, { required: true });
      const id = args._[2];
      const timeoutMs = args.timeout !== undefined ? Number(args.timeout) * 1000 : undefined;
      if (timeoutMs !== undefined && !(timeoutMs >= 0)) throw new UsageError('--timeout takes seconds');
      log(`session ${s.name}: waiting for ${id ? `call ${id}` : 'the running (or last) call'}`);
      const { record, result } = await waitCall(s, id, { timeoutMs });
      log(`session ${s.name}: ${record.op} call ${record.callId} finished (${record.finishedAt})`);
      if (printers[record.op]) return printers[record.op](result, args);
      if (!args.json) console.log(JSON.stringify(result, null, 2));
      return result;
    }
    throw new UsageError(`Unknown: aft session ${sub} (start, status, stop, wait)`);
  },

  /** Do / redo until here: the tour unrecorded up to a point, handed off live (src/stage.mjs). */
  async stage(args) {
    const sub = args._[1];
    const outRoot = path.resolve(process.env.AFT_OUT_DIR ?? path.join(toolRoot, 'out'));
    const undoDead = async runDir => commands.cleanup({ _: ['cleanup', runDir] }).catch(e => ({ error: e.message.split('\n')[0] }));
    if (sub === 'list') {
      const stages = listStages(toolRoot);
      if (!args.json) {
        for (const s of stages) console.log(`${s.name.padEnd(40)} ${String(s.state).padEnd(8)} ${s.reached ?? describePoint(s.point)}  ${s.url ?? ''}`);
        if (!stages.length) console.log('no stages');
      }
      return { stages };
    }
    if (sub === 'end') {
      const name = args._[2] ?? args.session;
      const s = readSessions(toolRoot).find(x => x.name === name && x.name.startsWith('stage-'));
      if (!s) throw new UsageError(`No stage "${name ?? ''}" (stages: ${listStages(toolRoot).map(x => x.name).join(', ') || 'none'}); usage: aft stage end <name> [--keep]`);
      const r = await endStage(toolRoot, s, { keep: args.keep === undefined ? undefined : args.keep !== 'false', undoDead });
      const failed = r.undo?.failed?.length ?? 0;
      log(`stage ${s.name}: ended${r.kept ? ', data kept (aft cleanup <run> undoes it later)' : r.undo ? `: ${r.undo.undone} undone${failed ? `, ${failed} failed` : ''}` : ''}`);
      if (failed) throw Object.assign(new UsageError(`${failed} undo step(s) failed; the data is left in ${s.stage?.runDir}/ledger.json for aft cleanup`), { data: r });
      return r;
    }
    const srcArg = sub;
    if (!srcArg) throw new UsageError('Usage: aft stage <tour.json | run folder> [--target env] [--as role] [--until-scene N [--step J] | --until-step N | --setup-only] [--keep] [--redo]  ·  aft stage list  ·  aft stage end <name> [--keep]');
    const src = stageSource(srcArg);
    if (!src?.file) throw new UsageError(src ? `${src.runDir} has no tour.json (and its run.json names no tour file)` : `No such tour or run folder: ${srcArg}`);
    if (!src.file.endsWith('.json')) throw new UsageError('aft stage takes a tour.json (code tours can\'t be staged)');
    let point;
    try { point = stagePoint(args); } catch (e) { throw new UsageError(e.message); }
    const target = envOf(args) ?? src.env;
    const def = loadTourJson(src.file, { env: target, baseUrl: args.baseUrl, role: args.role, toolRoot });
    const name = stageName(def.name, def.env);
    if (args.keep && def.warnings?.length) throw new UsageError(`--keep on a shared environment needs tagged data: ${def.warnings.join('; ')}`);
    // One stage per tour and environment: --redo ends it (undoing its data) and stages again.
    const existing = readSessions(toolRoot).find(s => s.name === name);
    let replaced = null;
    if (existing?.alive && !args.redo) throw new UsageError(`${def.name} is already staged${def.env ? ` on ${def.env}` : ''} (${name}, ${existing.stage?.reached ?? existing.stage?.state ?? existing.status}): --redo to end it and stage again, or aft stage end ${name}`);
    if (existing) {
      log(`stage ${name}: ending the current one first`);
      replaced = await endStage(toolRoot, existing, { keep: false, undoDead });
      const failed = replaced.undo?.failed?.length ?? 0;
      if (failed && !args.force) throw Object.assign(new UsageError(`ending the current stage: ${failed} undo step(s) failed (${replaced.undo.failed.map(f => `${f.name}: ${f.error}`).join('; ')}); --force stages anyway (the leftover stays in its ledger for aft cleanup)`), { data: replaced });
    }
    const r = startRun(runName(def, args), args, 'stage');
    lastRunDir = r.dir;
    const s = await startStage({ toolRoot, name, outDir: r.dir, echo: text => process.stderr.write(text),
      job: { file: src.file, sourceRun: src.runDir, point, keep: !!args.keep, args: { target, role: args.role, as: args.as, headless: !!args.headless, freshLogin: !!args.freshLogin } } });
    const view = stageView({ ...s, alive: s.status === 'ready' });
    if (s.status === 'failed') fs.rmSync(path.join(sessionsDir(toolRoot), `${name}.json`), { force: true });
    if (!args.json) console.log(`${name}: ${view.state}${view.reached ? `, ${view.reached}` : ''}${view.url ? ` at ${view.url}` : ''}\n  end:  aft stage end ${name}${view.keep ? '' : ' [--keep]'}\n  redo: aft stage ${srcArg} --redo`);
    const data = { ...view, ...(replaced ? { replaced } : {}) };
    if (view.state === 'failed') throw Object.assign(new Failure(view.class ?? 'error', `stage ${name}: ${view.error}`), { data });
    return data;
  },

  async snapshot(args) {
    const r = await withSession(args, (s, live) => (live ? call(s, 'snapshot', { url: args.url, screenshot: !!args.screenshot }) : s.snapshot({ url: args.url, screenshot: !!args.screenshot })));
    return printers.snapshot(r, args);
  },

  async locate(args) {
    const target = parseArg(args._.slice(1).join(' ') || args.target_, 'target (a string or JSON target)');
    const r = await withSession(args, (s, live) => (live ? call(s, 'locate', { target, url: args.url }) : s.locate(target, { url: args.url })));
    return printers.locate(r, args);
  },

  async 'try-step'(args) {
    const step = parseArg(args._.slice(1).join(' '), 'step (JSON: {"click": "Save"} or [steps])');
    if (typeof step === 'string') throw new UsageError('try-step takes a JSON step, e.g. \'{"click": "Save"}\'');
    const r = await withSession(args, (s, live) => (live ? call(s, 'try-step', { step, url: args.url }) : s.tryStep(step, { url: args.url })));
    return printers['try-step'](r, args);
  },

};

/** How snapshot, locate and try-step print their result (also aft session wait, which returns one of them). */
const printers = {
  snapshot(r, args) {
    if (!args.json) console.log(`${r.url}  "${r.title}"\n\n${r.aria}`);
    return r;
  },
  locate(r, args) {
    if (!args.json) {
      console.log(r.resolved ? `resolves: ${JSON.stringify(r.strategy)} → element ${r.uses}${r.ambiguous ? ` (ambiguous: ${r.matches.length} visible)` : ''}` : 'does not resolve');
      for (const m of r.matches) console.log(`  [${m.index}] <${m.tag}>${m.role ? ` role=${m.role}` : ''} ${m.text ?? m.name ?? ''}`);
      if (r.alternatives.length) console.log(`closest on the page: ${r.alternatives.map(a => JSON.stringify(a)).join(', ')}`);
    }
    return r;
  },
  'try-step'(r, args) {
    if (!args.json) {
      for (const e of r.steps) console.log(`${e.ok ? 'ok  ' : 'FAIL'} ${e.action} ${JSON.stringify(e.spec[e.action] ?? '').slice(0, 70)}${e.ok ? '' : `: ${e.error}`}`);
      console.log(`\n${r.ok ? 'ok' : r.class.toUpperCase()}; now at ${r.after.url}`);
    }
    if (!r.ok) throw Object.assign(new Error(r.error), { failure: r.class, data: r });
    return r;
  },

};

/** The comment block at the top of this file is the help text, so the two can't drift apart. */
function helpText() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
  return lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
}

/**
 * Git Bash (MSYS) turns an argument that starts with / into a Windows path under its install folder, so "#/case/1" in a
 * --url or a try-step's JSON arrives as "C:/Program Files/Git/case/1". The original can't be recovered reliably: refuse.
 */
function gitBashCheck(argv) {
  if (process.env.MSYS_NO_PATHCONV === '1') return;
  const root = (process.env.EXEPATH ? path.dirname(process.env.EXEPATH) : null) ?? null;
  const roots = [root, 'C:/Program Files/Git', 'C:/Program Files (x86)/Git', 'C:/msys64'].filter(Boolean).map(r => r.replace(/\\/g, '/').toLowerCase());
  const bad = argv.find(a => { const s = a.replace(/\\/g, '/').toLowerCase(); return roots.some(r => s.includes(`${r}/`)) && !fs.existsSync(a); });
  if (bad) throw new UsageError(`"${bad.slice(0, 120)}" looks like a path Git Bash rewrote (it turns arguments starting with / into Windows paths). Run with MSYS_NO_PATHCONV=1 (export MSYS_NO_PATHCONV=1), or use PowerShell`);
}

/** --json: stdout carries exactly one JSON document; everything else (logs, tables) is moved to stderr. */
const stdoutLog = console.log.bind(console);
let json = false;
const emit = doc => stdoutLog(JSON.stringify({ schema: 'aft-cli/1', ...doc }, null, 2));

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.json) { json = true; console.log = (...a) => console.error(...a); }
  gitBashCheck(process.argv.slice(2));
  if (args.listVoices) { console.log((await listVoices()).join('\n')); return; }
  if (args.version) { console.log(JSON.parse(fs.readFileSync(path.join(toolRoot, 'package.json'), 'utf8')).version); return; }
  const cmd = args._[0];
  if (args.help || cmd === 'help' || !cmd) { console.log(helpText()); return; }
  if (!cmd) throw new UsageError('Usage: aft generate|validate|run|all|render|discover|plan|auto|login ... (see src/cli.mjs or the README)');
  const command = commands[cmd] ? cmd : /\.(mjs|json)$/.test(cmd) ? 'render' : null;
  if (!command) throw new UsageError(`Unknown command "${cmd}"`);
  const data = await commands[command](command === cmd ? args : { ...args, _: ['render', ...args._] });
  if (json) emit({ command: ['platform', 'session', 'stage'].includes(command) ? `${command} ${args._[1] ?? ''}`.trim() : command, ok: true, exitCode: process.exitCode ?? 0,
    class: 'ok', ...(lastRunDir ? { runDir: lastRunDir } : {}), data: data ?? null });
}

main().catch(e => {
  // Exit codes come from one table (src/failures.mjs); usage/config errors and drafts are classified here.
  const cls = e instanceof UsageError || e instanceof ConfigError ? 'error' : e.failure ?? (e instanceof StepError ? 'script' : e instanceof UnreachableError ? 'unreachable' : classify(e));
  const code = CLASSES[cls]?.exit ?? 1;
  if (cls === 'error' && !(e instanceof UsageError) && !(e instanceof ConfigError)) console.error(e.stack ?? e);
  // Config errors (schema problems) list every problem, one per line; the rest are one line.
  else if (e instanceof ConfigError) console.error(`error: ${e.message}`);
  else console.error(`error: ${summaryLine(Object.assign(e, { failure: e.failure ?? cls }))}`);
  if (json) {
    const args = parseArgs(process.argv.slice(2));
    const report = lastRunDir && fs.existsSync(path.join(lastRunDir, 'report.json')) ? path.join(lastRunDir, 'report.json') : undefined;
    const sub = ['platform', 'session', 'stage'].includes(args._[0]) ? ` ${args._[1] ?? ''}` : '';
    emit({ command: args._[0] ? `${args._[0]}${sub}`.trim() : null, ok: false, exitCode: code, class: cls, ...(lastRunDir ? { runDir: lastRunDir } : {}), ...(report ? { report } : {}),
      error: { message: e.message.split('\n')[0], ...(e.message.includes('\n') ? { details: e.message.split('\n').slice(1).map(l => l.trim()).filter(Boolean) } : {}),
        ...(e.entry ? { step: e.entry } : {}) }, data: e.data ?? lastData ?? null });
  }
  process.exit(code);
});
