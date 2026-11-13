// aft run --reuse [<run>]: footage of browser scenes that haven't changed is taken from an earlier run instead of
// being recorded again. Each recorded run writes <run>/reuse.json: a fingerprint of every browser scene (its expanded
// steps, url, platform, camera, narration as spoken, voice and rate) and of what the whole run depends on (the tour's
// composed app settings: platform, environment, fixtures, mocks, known issues…; the "pages" folder's contents).
//
// The browser's state carries from scene to scene, so footage is reused only for the unchanged browser scenes at the
// start, in order: from the first changed one on, everything is recorded again. Unchanged scenes before it still run
// (the app has to reach that state), fast and unpaced (--from-step), and their old clips replace the new footage. When
// no browser scene changed, the browser isn't started at all: the run's checks are the earlier run's (said in the
// report). Slides are always drawn and narrated afresh; they never need the browser.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spokenText } from './script.mjs';

const SCHEMA = 'aft-reuse/1';

/** Keys of a composed tour that don't change what the browser does or shows. */
const PRESENTATION = new Set(['$schema', 'name', 'title', 'description', 'story', 'review', 'findings', 'slides', 'style', 'comment',
  'voice', 'rate', 'pronounce', 'scenes', 'video', 'stage', 'warnings']);

const hash = v => crypto.createHash('sha256').update(typeof v === 'string' ? v : stable(v)).digest('hex').slice(0, 16);

/** JSON with sorted keys, so the same value always hashes the same. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The contents of a folder (every file's relative path and bytes). */
function folderHash(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { h.update(path.relative(dir, f).split(path.sep).join('/')); h.update(fs.readFileSync(f)); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

const isSlide = s => !!s.slide;

/**
 * Fingerprints of a loaded tour (loadTourJson: def.raw has the composed settings and the expanded steps).
 * speech(scene, def): { voice, rate, tail } that says a scene (as configured: names, not resolved voices). Returns { schema, context, scenes: [{ number, id, browser,
 * filmed, steps, key }] }; key is null for slides.
 */
export function fingerprints(def, speech) {
  const raw = def.raw;
  const context = hash({ settings: Object.fromEntries(Object.entries(raw).filter(([k]) => !PRESENTATION.has(k))), pages: folderHash(def.pagesDir), env: def.env ?? null });
  const scenes = raw.scenes.map((s, i) => {
    const number = i + 1, id = `scene-${String(number).padStart(2, '0')}`;
    if (isSlide(s)) return { number, id, browser: false, filmed: s.camera !== false, steps: 0, key: null };
    const sp = speech(s, def) ?? {};
    const key = hash({ context, url: s.url ?? null, platform: s.platform ?? null, camera: s.camera ?? null, steps: s.steps ?? [],
      ...(s.camera === false ? {} : { said: spokenText(s.narration ?? '', def.pronounce), voice: sp.voice ?? null, rate: sp.rate ?? 0, tail: sp.tail ?? null }) });
    return { number, id, browser: true, filmed: s.camera !== false, steps: (s.steps ?? []).length, key };
  });
  return { schema: SCHEMA, context, scenes };
}

export function writeFingerprints(outDir, fp) {
  fs.writeFileSync(path.join(outDir, 'reuse.json'), JSON.stringify(fp, null, 2) + '\n');
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** A finished recording: run.json says done, and its clips and timings are there. */
const usable = dir => {
  const info = readJson(path.join(dir, 'run.json'));
  return info?.command === 'run' && info.status === 'done' && fs.existsSync(path.join(dir, 'timings.json')) && fs.existsSync(path.join(dir, 'clips'));
};

/** The run to reuse: the one given, else the newest finished recording beside this run (same tour name). */
export function findSource(given, outDir) {
  if (typeof given === 'string') {
    const dir = path.resolve(given);
    if (!fs.existsSync(dir)) throw new Error(`--reuse: no such run folder ${dir}`);
    if (!usable(dir)) throw new Error(`--reuse: ${dir} isn't a finished recording (it needs run.json "done" from aft run, timings.json and clips/)`);
    return dir;
  }
  const base = path.dirname(outDir);
  const runs = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && path.join(base, e.name) !== outDir)
    .map(e => e.name).sort().reverse();
  const found = runs.map(r => path.join(base, r)).find(usable);
  return found ?? null;
}

/**
 * The earlier run's fingerprints: its reuse.json, else (a run made before reuse.json existed) its source/ copy of the
 * tour, loaded now (load(file) → def): platform files are then compared as they are today, which the caller warns about.
 */
export function sourceFingerprints(dir, load, speech) {
  const own = readJson(path.join(dir, 'reuse.json'));
  if (own?.schema === SCHEMA) return { fp: own, exact: true };
  const src = path.join(dir, 'source');
  const file = fs.existsSync(src) && fs.readdirSync(src).find(f => f.endsWith('.json'));
  if (!file) return null;
  return { fp: fingerprints(load(path.join(src, file)), speech), exact: false };
}

/**
 * What can be reused: the unchanged browser scenes at the start, in order (paired by position among browser scenes,
 * so inserted or removed slides don't matter). Returns { scenes: [{ id (this run's), from (the old run's id) }],
 * all (no browser scene changed), changed (the first changed scene, or why none could be reused), fromStep }.
 */
export function plan(fresh, old, dir, { force = [] } = {}) {
  const again = new Set(force.map(Number));
  const a = fresh.scenes.filter(s => s.browser), b = old.scenes.filter(s => s.browser);
  const scenes = [];
  let steps = 0, changed = null;
  if (fresh.context !== old.context) changed = 'the tour\'s app settings changed (platform, environment, fixtures, mocks, known issues or pages)';
  else for (const [k, s] of a.entries()) {
    const o = b[k];
    if (again.has(s.number)) { changed = `${s.id} was chosen to record again`; break; }
    if (!o || o.key !== s.key) { changed = `${s.id} changed`; break; }
    if (s.filmed && !fs.existsSync(path.join(dir, 'clips', `${o.id}.mp4`))) { changed = `${s.id}: no clip for it in the earlier run`; break; }
    scenes.push({ id: s.id, from: o.id, filmed: s.filmed });
    steps += s.steps;
  }
  const all = !changed; // every browser scene of this tour has its footage (the earlier run may have had more)
  return { dir, scenes, all, changed, fromStep: steps + 1 };
}

/**
 * For the UI: each browser scene's fate on `aft run --reuse --record-again <force>`, and whether it changed by itself.
 * state: reuse (its old footage) | record (changed, chosen, no clip, or app settings changed) | after (unchanged,
 * recorded because an earlier scene is). titles: the tour's scene titles.
 */
export function preview(fresh, old, dir, { force = [], titles = [] } = {}) {
  const p = plan(fresh, old, dir, { force });
  const reused = new Set(p.scenes.map(s => s.id));
  const b = old.scenes.filter(s => s.browser);
  let first = true;
  const scenes = fresh.scenes.filter(s => s.browser).map((s, k) => {
    const o = b[k];
    const own = fresh.context === old.context && !!o && o.key === s.key && (!s.filmed || fs.existsSync(path.join(dir, 'clips', `${o.id}.mp4`)));
    let state = 'reuse', why = 'unchanged: its old footage';
    if (!reused.has(s.id)) {
      if (first) { state = 'record'; why = p.changed; first = false; }
      else { state = 'after'; why = own ? 'unchanged, but recorded: an earlier scene is, and the app\'s state carries over' : 'changed'; }
      if (!own && state === 'after') state = 'record';
    }
    return { number: s.number, id: s.id, title: titles[s.number - 1] ?? s.id, filmed: s.filmed, changed: !own, forced: force.map(Number).includes(s.number), state, why };
  });
  return { run: dir, all: p.all, changed: p.changed, scenes };
}

/** The voice settings `aft run` uses with no --voice / --rate / --tail (what the UI's MAKE VIDEO runs). */
export const defaultSpeech = (s, d) => ({ voice: s.voice ?? d.voice ?? null, rate: Number(s.rate ?? d.rate ?? 0), tail: s.hold ?? 0.75 });

/**
 * The UI's reuse panel: for a tour file, the newest finished recording of it under outRoot and preview() against it.
 * null when there is none (nothing to reuse yet).
 */
export async function previewFor({ file, toolRoot, outRoot, env, force = [] }) {
  const { loadTourJson } = await import('./declarative.mjs');
  const load = f => loadTourJson(f, { env, toolRoot });
  const def = load(file);
  if (def.needsBrowser === false) return { slidesOnly: true, scenes: [] };
  const safe = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tour';
  const name = def.story?.id && !def.name.startsWith(def.story.id) ? `${def.story.id}-${def.name}` : def.name;
  const base = path.join(outRoot, safe(name));
  if (!fs.existsSync(base)) return null;
  const dir = findSource(true, path.join(base, '(new)'));
  if (!dir) return null;
  const src = sourceFingerprints(dir, load, defaultSpeech);
  if (!src) return null;
  return { ...preview(fingerprints(def, defaultSpeech), src.fp, dir, { force, titles: def.raw.scenes.map(s => s.title) }), exact: src.exact };
}
