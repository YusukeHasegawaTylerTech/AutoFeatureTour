// Moving a tour between machines: a dev writes and checks it where the code and data are (local dev), exports it, and
// QA imports it into their own platform (another environment of the same app) and runs it there.
//
//   aft export <tour.json | run folder>            → <run>/<name>.aft.json (one self-contained file)
//   aft import <file.aft.json> --platform <name>   → platforms/<name>/tours/<name>.tour.json (+ <name>-files/)
//
// The export holds the tour as it ran: fragments inlined (so the target's fragments can't change it), code steps and
// upload files embedded, and where it came from (platform, environment, the dev's last result). It holds no URLs,
// credentials or platform settings: the target platform supplies those, its fixtures (data lookups differ between
// environments) and its known issues. Fixtures and mock sets are referenced by name and must exist on the target.

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, readTourJson } from './declarative.mjs';
import { expandSteps, loadPlatform, PlatformError } from './platform.mjs';

// Problems are config errors (exit 1, no stack trace).
const wrap = fn => (...a) => { try { return fn(...a); } catch (e) { throw e instanceof PlatformError ? new ConfigError(e.message) : e; } };

import { findingIds, readNotes } from './notes.mjs';

export const EXPORT_SCHEMA = 'aft-export/1';
const SAFE = /^[A-Za-z0-9_-]+$/;

/** The tour file a run folder ran (run.json "input", or a tour.json written into it). */
export function tourOfRun(dir) {
  const run = readMaybe(path.join(dir, 'run.json'));
  const candidates = [...(run?.input ?? []).filter(f => /\.json$/.test(f)).map(f => path.resolve(f)), path.join(dir, 'tour.json')];
  const file = candidates.find(f => fs.existsSync(f));
  if (!file) throw new PlatformError(`${dir}: no tour file in its run.json or folder`);
  return { file, run };
}

/** The dev's evidence: the run folder's outcome (or the tour's latest successful run under out/). */
function provenance(run, runDir, report) {
  if (!run) return null;
  return {
    command: run.command, status: run.status, at: run.finishedAt ?? run.startedAt, run: path.basename(runDir ?? ''),
    result: report?.result ?? null,
    criteria: (report?.criteria ?? []).map(c => ({ id: c.id ?? c.criterion, status: c.status, text: c.text })),
  };
}

/**
 * Builds the export document. `source`: a tour file or a run folder. Returns { doc, name }.
 */
function exportTourImpl(source, { toolRoot, outRoot = path.join(toolRoot, 'out') } = {}) {
  let file = source, run = null, runDir = null;
  if (fs.statSync(source).isDirectory()) { runDir = path.resolve(source); ({ file, run } = tourOfRun(runDir)); }
  file = path.resolve(file);
  const raw = readTourJson(file);
  const dir = path.dirname(file);
  if (!run) {
    // A tour file: its newest successful run or validation of this file. Not latest.json: an export is a successful
    // command too, so a second export would otherwise carry the first export as its evidence.
    const base = path.join(outRoot, raw.name);
    let dirs = []; try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse(); } catch {}
    for (const d of dirs) {
      const r = readMaybe(path.join(base, d, 'run.json'));
      if (!r || r.status !== 'done' || !['run', 'validate'].includes(r.command)) continue;
      if (!(r.input ?? []).some(f => path.resolve(f) === file)) continue;
      // validate's run.json says "done" even when steps failed; its verdict is in validation.json
      if (r.command === 'validate' && (readMaybe(path.join(base, d, 'validation.json'))?.blocking ?? 0) > 0) continue;
      run = r; runDir = path.join(base, d); break;
    }
  }
  const report = runDir ? readMaybe(path.join(runDir, 'report.json')) : null;

  const p = raw.platform ? loadPlatform(toolRoot, raw.platform, { from: dir }) : null;
  const dirs = [...(p ? [path.join(p.dir, 'fragments')] : []), dir];
  const files = {};
  const embed = (abs, kind) => {
    const base = path.basename(abs);
    if (files[base] && files[base].from !== abs) throw new PlatformError(`two ${kind} files named ${base} (${files[base].from}, ${abs}); rename one`);
    files[base] = { from: abs, kind, base64: fs.readFileSync(abs).toString('base64') };
    return base;
  };
  const uploadDirs = [dir, ...(p ? [path.join(p.dir, 'fixtures')] : [])];
  // Fragments inlined with no data: {data.x} stays for the target's fixtures to fill in.
  const flatten = steps => expandSteps(steps ?? [], { dirs }).map(s => {
    const { from, ...step } = s;
    if (from) step.comment = [step.comment, `from fragment ${from}`].filter(Boolean).join('; ');
    if (step.code) step.code = embed(step.code, 'code');
    if (step.upload) step.files = [step.files].flat().map(f => {
      const hit = [f, ...uploadDirs.map(d => path.resolve(d, f))].find(x => path.isAbsolute(x) && fs.existsSync(x));
      if (!hit) throw new PlatformError(`${file}: upload file "${f}" not found (looked in ${uploadDirs.join(', ')})`);
      return embed(hit, 'upload');
    });
    return step;
  });
  const { platform: _p, env: _e, ...tour } = raw;
  tour.scenes = raw.scenes.map(s => ({ ...s, steps: flatten(s.steps) }));
  const doc = {
    schema: EXPORT_SCHEMA,
    name: raw.name,
    exportedAt: new Date().toISOString(),
    source: { platform: raw.platform ?? null, env: run?.args?.target ?? run?.args?.env ?? raw.env ?? p?.defaultEnv ?? null, file: path.relative(toolRoot, file).replace(/\\/g, '/'),
      ...(provenance(run, runDir, report) ? { last: provenance(run, runDir, report) } : {}) },
    requires: { fixtures: raw.fixtures ?? [], mocks: raw.mocks ?? [], role: raw.role ?? null },
    tour,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { kind: v.kind, base64: v.base64 }])),
    // The platform's own notes (accounts, setup recipes, findings), so the target gets what was learned here.
    notes: p ? readNotes(p.dir).filter(n => !n.file.startsWith('imported/')).map(({ file: f, meta, findings, text }) => ({ file: f, meta, findings, text })) : [],
  };
  return { doc, name: raw.name };
}

/**
 * Writes an export into a platform: tours/<name>.tour.json and its files in tours/<name>-files/. Never overwrites
 * unless `force`. Returns { tour, files, missing[], source } (missing: what the platform must still provide).
 */
function importTourImpl(bundleFile, { toolRoot, platform, name, force = false }) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(bundleFile, 'utf8')); } catch (e) { throw new PlatformError(`${bundleFile}: not valid JSON (${e.message})`); }
  if (doc?.schema !== EXPORT_SCHEMA) throw new PlatformError(`${bundleFile}: not an aft export (expected "schema": "${EXPORT_SCHEMA}")`);
  const p = loadPlatform(toolRoot, platform);
  name ??= doc.name;
  if (!SAFE.test(name)) throw new PlatformError(`Tour names must match ${SAFE} (got "${name}"); pass --name`);
  const toursDir = path.join(p.dir, 'tours');
  const tourFile = path.join(toursDir, `${name}.tour.json`);
  const filesDir = path.join(toursDir, `${name}-files`);
  if (fs.existsSync(tourFile) && !force) throw new PlatformError(`${tourFile} exists; pass --force to replace it, or --name <other>`);

  const rel = f => `${name}-files/${f}`;
  const scenes = doc.tour.scenes.map(s => ({ ...s, steps: (s.steps ?? []).map(st => ({
    ...st,
    ...(st.code ? { code: rel(st.code) } : {}),
    ...(st.upload ? { files: [st.files].flat().map(rel) } : {}),
  })) }));
  const from = doc.source?.platform ? `${doc.source.platform}${doc.source.env ? ` (${doc.source.env})` : ''}` : 'a stand-alone tour';
  const last = doc.source?.last;
  const note = `Imported from ${from} (${doc.source?.file ?? '?'}), exported ${doc.exportedAt}${last ? `; there: ${last.command} ${last.result ?? last.status} at ${last.at}` : ''}. Fragments are inlined as they were there.`;
  const tour = { $schema: '../../../schemas/tour.schema.json', ...doc.tour, name, platform, comment: [doc.tour.comment, note].filter(Boolean).join(' '), scenes };

  const missing = [
    ...(doc.requires?.fixtures ?? []).filter(f => !fs.existsSync(path.join(p.dir, 'fixtures', `${f}.json`))).map(f => `fixture "${f}" (platforms/${platform}/fixtures/${f}.json)`),
    ...(doc.requires?.mocks ?? []).filter(m => !fs.existsSync(path.join(p.dir, 'mocks', `${m}.json`))).map(m => `mock set "${m}" (platforms/${platform}/mocks/${m}.json)`),
    ...(doc.requires?.role && !p.login?.roles?.[doc.requires.role] ? [`login role "${doc.requires.role}" (platforms/${platform}/login.json)`] : []),
  ];
  fs.mkdirSync(toursDir, { recursive: true });
  const written = [];
  if (Object.keys(doc.files ?? {}).length) {
    fs.mkdirSync(filesDir, { recursive: true });
    for (const [f, v] of Object.entries(doc.files)) {
      if (path.basename(f) !== f) throw new PlatformError(`${bundleFile}: bad file name "${f}"`);
      fs.writeFileSync(path.join(filesDir, f), Buffer.from(v.base64, 'base64'));
      written.push(path.join(filesDir, f));
    }
  }
  fs.writeFileSync(tourFile, JSON.stringify(tour, null, 2) + '\n');

  // Notes go to notes/imported/<source platform>/, never over the target's own notes; an earlier import of the same
  // file is kept unless --force. newFindings: ids the target's own notes don't have yet.
  const notes = { written: [], kept: [], newFindings: [] };
  if (doc.notes?.length) {
    const own = findingIds(readNotes(p.dir).filter(n => !n.file.startsWith('imported/')));
    const srcName = SAFE.test(String(doc.source?.platform ?? '')) ? doc.source.platform : 'standalone';
    const notesDir = path.join(p.dir, 'notes', 'imported', srcName);
    for (const n of doc.notes) {
      const rel = String(n?.file ?? '').replace(/\\/g, '/');
      if (!rel || rel.split('/').some(x => !x || x === '..' || x === '.') || !/\.md$/i.test(rel) || typeof n.text !== 'string')
        throw new PlatformError(`${bundleFile}: bad notes file name "${n?.file}"`);
      const out = path.join(notesDir, ...rel.split('/'));
      if (fs.existsSync(out) && !force) notes.kept.push(out);
      else { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, n.text); notes.written.push(out); }
      for (const f of n.findings ?? []) if (f?.id && !own.has(f.id) && !notes.newFindings.some(x => x.id === f.id)) notes.newFindings.push({ id: f.id, title: f.title ?? '', file: rel });
    }
  }
  return { tour: tourFile, files: written, missing, source: doc.source, notes };
}

function readMaybe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export const exportTour = wrap(exportTourImpl);
export const importTour = wrap(importTourImpl);
