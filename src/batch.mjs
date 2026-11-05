// aft batch: several tours, one environment reset. Each tour runs as its own `aft run` / `aft validate` child
// process (the normal run path, its own run folder); the batch folder only records what happened (batch.json, batch.md).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Tour files from arguments: files, folders (their *.tour.json, sorted) and globs, in the order given, no duplicates. */
export function expandTours(inputs) {
  const out = [];
  const add = f => { const a = path.resolve(f); if (!out.includes(a)) out.push(a); };
  for (const input of inputs) {
    if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
      for (const f of fs.readdirSync(input).filter(f => f.endsWith('.tour.json')).sort()) add(path.join(input, f));
    } else if (fs.existsSync(input)) add(input);
    else if (/[*?[]/.test(input)) {
      const found = fs.globSync(input.replace(/\\/g, '/')).filter(f => f.endsWith('.json')).sort();
      if (!found.length) throw Object.assign(new Error(`no tour matches ${input}`), { usage: true });
      found.forEach(add);
    } else throw Object.assign(new Error(`No such tour file: ${path.resolve(input)}`), { usage: true });
  }
  return out;
}

/** The flags passed on to each tour's run (batch-only ones are dropped). */
export function childArgs(args) {
  const skip = new Set(['_', 'json', 'reset', 'validateOnly', 'stopOnFail', 'out', 'name']);
  const flag = k => '--' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (skip.has(k) || v === false || v == null) continue;
    out.push(flag(k));
    if (v !== true) out.push(String(v));
  }
  return out;
}

function runChild(cliPath, argv, onChild) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [cliPath, ...argv], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    onChild(p);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('exit', code => { let doc = null; try { doc = JSON.parse(out); } catch {} resolve({ code: code ?? 130, doc }); });
  });
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * Runs the tours in order. `state.stop` (set on Ctrl+C) stops after the current tour; the rest are "skipped".
 * Returns the batch document (schema aft-batch/1); batch.json is rewritten after every tour.
 */
export async function runBatch({ tours, args, cliPath, dir, reset, log, state }) {
  const command = args.validateOnly ? 'validate' : 'run';
  const doc = { schema: 'aft-batch/1', command, dir, startedAt: new Date().toISOString(), status: 'running', platform: reset?.platform ?? null,
    env: reset?.env ?? null, reset: reset?.result ?? null,
    tours: tours.map(t => ({ tour: t.file, name: t.name, status: 'pending' })) };
  const save = () => {
    fs.writeFileSync(path.join(dir, 'batch.json'), JSON.stringify(doc, null, 2));
    fs.writeFileSync(path.join(dir, 'batch.md'), batchMarkdown(doc));
  };
  save();
  const extra = childArgs(args);
  let stopNext = false;
  for (const t of doc.tours) {
    if (state.stop || stopNext) { t.status = 'skipped'; continue; }
    log(`batch: ${command} ${t.tour}`);
    t.startedAt = new Date().toISOString();
    t.status = 'running';
    save();
    const { code, doc: res } = await runChild(cliPath, [command, t.tour, '--json', ...extra], p => { state.child = p; });
    state.child = null;
    const runDir = res?.runDir ?? null;
    const report = runDir && (readJson(path.join(runDir, 'report.json')) ?? readJson(path.join(runDir, 'validation.json')));
    Object.assign(t, { status: code === 0 ? 'passed' : code === 130 ? 'interrupted' : 'failed', exitCode: code, class: res?.class ?? (code === 0 ? 'ok' : 'error'),
      runDir, verdict: report?.review?.verdict ?? null, ...(res?.error ? { error: res.error.message } : {}), finishedAt: new Date().toISOString() });
    if (code === 130) state.stop = true;
    if (code !== 0 && args.stopOnFail) stopNext = true;
    save();
  }
  const first = doc.tours.find(t => t.exitCode && t.exitCode !== 0);
  Object.assign(doc, { finishedAt: new Date().toISOString(), status: state.stop ? 'interrupted' : first ? 'failed' : 'passed',
    exitCode: state.stop ? 130 : first?.exitCode ?? 0,
    counts: Object.fromEntries(['passed', 'failed', 'interrupted', 'skipped'].map(s => [s, doc.tours.filter(t => t.status === s).length])) });
  save();
  return doc;
}

export function batchMarkdown(doc) {
  const c = doc.counts;
  const lines = [`# Batch ${path.basename(doc.dir)}: ${doc.status.toUpperCase()}`, '',
    `${doc.command} of ${doc.tours.length} tour(s)${doc.platform ? ` on ${doc.platform}${doc.env ? ` / ${doc.env}` : ''}` : ''}` +
      (c ? `: ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped${c.interrupted ? `, ${c.interrupted} interrupted` : ''}` : ''),
    doc.reset ? `Reset: ran before the first tour (${doc.reset.runDir ?? ''}).` : 'Reset: not requested.', '',
    '| # | tour | status | exit | class | verdict | run folder |', '|---|---|---|---|---|---|---|'];
  doc.tours.forEach((t, i) => lines.push(`| ${i + 1} | ${t.name} | ${t.status} | ${t.exitCode ?? ''} | ${t.class ?? ''} | ${t.verdict ?? ''} | ${t.runDir ?? ''} |`));
  const failed = doc.tours.filter(t => t.error);
  if (failed.length) lines.push('', '## Failures', '', ...failed.map(t => `- **${t.name}**: ${t.error}`));
  return lines.join('\n') + '\n';
}
