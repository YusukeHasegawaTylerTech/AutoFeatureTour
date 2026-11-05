#!/usr/bin/env node
// AutoFeatureTour UI: a local web app over the files and the CLI.
//   node ui/server.mjs [--port 4777] [--no-open] [--root <checkout>]
// --root (or AFT_ROOT) picks the checkout whose platforms/, out/ and CLI are used (default: this one).
// It never imports engine internals: it reads platforms/ and out/, writes definition files, and runs `aft … --json`
// as child processes. Bound to 127.0.0.1; every call needs the token printed in the URL (kept in a cookie).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const uiDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(uiDir, 'public');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(opt('--root') ?? process.env.AFT_ROOT ?? path.resolve(uiDir, '..'));
const port = Number(opt('--port') ?? 4777);
const cli = path.join(root, 'src', 'cli.mjs');
const outDir = path.join(root, 'out');
const platformsDir = path.join(root, 'platforms');
// AFT_UI_TOKEN fixes the token (for scripted use, e.g. recording a tour of the UI); default: random per start.
const token = process.env.AFT_UI_TOKEN || crypto.randomBytes(16).toString('hex');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.vtt': 'text/vtt', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.zip': 'application/zip', '.svg': 'image/svg+xml' };

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const within = (base, p) => { const r = path.resolve(base, p); return r === base || r.startsWith(base + path.sep) ? r : null; };
const body = req => new Promise((ok, bad) => { let s = ''; req.on('data', c => (s += c)); req.on('end', () => {
  try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });
const writeAtomic = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
};

/** name, name-2, name-3 … : the first that doesn't exist in dir (with ext). */
function freeName(dir, name, ext) {
  const base = String(name).replace(/[^\w.-]+/g, '-');
  for (let i = 1; ; i++) { const n = i === 1 ? base : `${base}-${i}`; if (!fs.existsSync(path.join(dir, n + ext))) return n; }
}

// ---- platforms ----
// Editable: every definition / support file under platforms/<p>/. Never dotfiles (.env), auth state or node_modules.
const EDITABLE = /\.(json|mjs|md|ps1|cs|html|css|txt)$/i;
function platformFile(rel) {
  const f = within(root, rel ?? '');
  if (!f || !f.startsWith(platformsDir + path.sep)) return null;
  const parts = path.relative(platformsDir, f).split(path.sep);
  if (parts.length < 2 || parts.some(p => p.startsWith('.') || p === 'node_modules') || !EDITABLE.test(f)) return null;
  return f;
}
function kindOf(rel) {
  const [a, b] = rel.split('/');
  if (b === undefined) return { 'platform.json': 'platform', 'environments.json': 'environments', 'login.json': 'login' }[a] ?? 'other';
  if (/\.tour\.(json|mjs)$/.test(b)) return 'tour';
  return { fragments: 'fragment', fixtures: 'fixture', mocks: 'mocks' }[a] ?? 'other';
}
function walkFiles(dir, base, rel = '') {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.') || f === 'node_modules') continue;
    const p = path.join(dir, f), r = rel ? `${rel}/${f}` : f;
    if (isDir(p)) out.push(...walkFiles(p, base, r));
    else if (EDITABLE.test(f)) out.push({ path: `${base}/${r}`, rel: r, kind: kindOf(r), size: fs.statSync(p).size });
  }
  return out;
}
const envFile = dir => readJson(path.join(dir, 'environments.json')) ?? {};
const envNames = envs => Object.keys(envs).filter(k => !k.startsWith('$') && k !== 'default');
function listPlatforms() {
  if (!isDir(platformsDir)) return [];
  return fs.readdirSync(platformsDir).filter(n => !n.startsWith('.') && isDir(path.join(platformsDir, n))).map(name => {
    const dir = path.join(platformsDir, name), envs = envFile(dir);
    const tours = walkFiles(dir, `platforms/${name}`).filter(f => f.kind === 'tour').map(f => ({ file: f.rel.replace(/^tours\//, ''), path: f.path }));
    return { name, default: envs.default, environments: envNames(envs), tours };
  });
}
function dotEnvNames() {
  try { return fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).map(l => /^\s*([A-Za-z_]\w*)\s*=/.exec(l)?.[1]).filter(Boolean); }
  catch { return []; }
}
function platformDetail(name) {
  const dir = within(platformsDir, name);
  if (!dir || path.dirname(dir) !== platformsDir || !isDir(dir)) return null;
  const files = walkFiles(dir, `platforms/${name}`);
  // {env:NAME} references in its JSON files, and whether each is set: names only, never values.
  const refs = new Set();
  for (const f of files.filter(f => f.path.endsWith('.json')))
    for (const m of fs.readFileSync(path.join(root, f.path), 'utf8').matchAll(/\{env:([A-Za-z_]\w*)\}/g)) refs.add(m[1]);
  const dot = new Set(dotEnvNames());
  const env = [...refs].sort().map(n => ({ name: n, source: n in process.env ? 'environment' : dot.has(n) ? '.env' : null }));
  const authDir = path.join(root, 'auth', name);
  // auth/<platform>/<env>/<role>.json; a <role>.json directly under auth/<platform>/ is the old layout, no longer read.
  const logins = !isDir(authDir) ? [] : fs.readdirSync(authDir).flatMap(e => {
    const p = path.join(authDir, e);
    if (!isDir(p)) return e.endsWith('.json') ? [{ env: null, role: e.replace(/\.json$/, ''), legacy: true, savedAt: fs.statSync(p).mtime }] : [];
    return fs.readdirSync(p).filter(f => f.endsWith('.json'))
      .map(f => ({ env: e, role: f.replace(/\.json$/, ''), savedAt: fs.statSync(path.join(p, f)).mtime }));
  });
  const envs = envFile(dir);
  // Per environment: shared (QA: data must carry {run.tag}) and whether it has "reset" hooks.
  const envInfo = Object.fromEntries(envNames(envs).map(e => [e, { baseUrl: envs[e]?.baseUrl ?? null, shared: !!envs[e]?.shared, reset: Array.isArray(envs[e]?.reset) && envs[e].reset.length > 0 }]));
  return { name, files, env, logins, default: envs.default, environments: envNames(envs), envInfo, baseUrl: envs[envs.default]?.baseUrl, cleanup: pendingCleanup(name) };
}

// ---- test data left behind: runs whose ledger.json still has undo pending (src/ledger.mjs; read as files) ----
const OPEN_UNDO = new Set(['pending', 'done', 'undo-failed']);
function pendingCleanup(platform) {
  const runs = [];
  if (!isDir(outDir)) return { runs, items: 0 };
  for (const name of fs.readdirSync(outDir)) {
    const base = path.join(outDir, name);
    if (name.startsWith('.') || name === 'sessions' || !isDir(base)) continue;
    for (const id of fs.readdirSync(base)) {
      const l = readJson(path.join(base, id, 'ledger.json'));
      if (!l || (platform && l.platform !== platform)) continue;
      const items = (l.items ?? []).filter(i => i.undo && OPEN_UNDO.has(i.status)).map(i => ({ name: i.name, kind: i.kind, status: i.status, error: i.undoError ?? null }));
      if (items.length) runs.push({ id: `${name}/${id}`, env: l.env ?? null, tag: l.tag ?? null, startedAt: l.startedAt, items });
    }
  }
  return { runs, items: runs.reduce((n, r) => n + r.items.length, 0) };
}

// ---- runs ----
const classOf = e => e ? (/^(SCRIPT|CRITERION|APP|LOGIN|TOOLING|UNREACHABLE|INTERRUPTED)/.exec(e)?.[1]?.toLowerCase() ?? 'error') : undefined;
function listRuns() {
  if (!isDir(outDir)) return [];
  const runs = [];
  for (const name of fs.readdirSync(outDir)) {
    const base = path.join(outDir, name);
    if (name === 'sessions' || name.startsWith('.') || !isDir(base)) continue;
    for (const id of fs.readdirSync(base)) {
      const info = readJson(path.join(base, id, 'run.json'));
      if (!info) continue;
      const run = { id: `${name}/${id}`, name, command: info.command, status: info.status, startedAt: info.startedAt,
        finishedAt: info.finishedAt, seconds: info.seconds, error: info.error, input: info.input, class: info.class ?? classOf(info.error) };
      // A dry run (validate) finishes "done" even when steps failed: the verdict is in validation.json.
      const v = info.command === 'validate' && info.status === 'done' ? readJson(path.join(base, id, 'validation.json')) : null;
      if (v?.blocking > 0) {
        const bad = (v.report ?? []).filter(s => s.ok === false && !s.optional);
        const f = bad[0] ?? {};
        const cls = f.failure ?? (f.kind === 'check' ? 'criterion' : 'script');
        Object.assign(run, { status: 'failed', class: cls, failedSteps: v.blocking,
          error: `${cls.toUpperCase()} failure: ${f.scene} step ${f.step} ${JSON.stringify(f.spec ?? {})}: ${f.error ?? 'failed'}`
            + (f.suggestions?.length ? ` (did you mean "${f.suggestions[0]}"?)` : '') });
      }
      // The review's reading of the outcome (src/review.mjs): passed, passed-with-issues, needs-review, failed, failed-app-issue
      const rv = (v ?? (info.command === 'validate' ? readJson(path.join(base, id, 'validation.json')) : readJson(path.join(base, id, 'report.json'))))?.review;
      if (rv) Object.assign(run, { verdict: rv.verdict, verdictLabel: rv.label, openFindings: rv.open });
      runs.push(run);
    }
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
function runDetail(id) {
  const dir = within(outDir, id);
  if (!dir || !isDir(dir)) return null;
  const files = [];
  const walk = (d, rel = '') => { for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f), r = rel ? `${rel}/${f}` : f;
    if (isDir(p)) walk(p, r); else files.push({ path: r, size: fs.statSync(p).size });
  } };
  walk(dir);
  return { id, run: readJson(path.join(dir, 'run.json')), report: readJson(path.join(dir, 'report.json')),
    timings: readJson(path.join(dir, 'timings.json')), files,
    // What the run created and what it set up: artifacts (fields already masked) and each ledger item's outcome
    // (never the undo steps themselves, which can hold values).
    artifacts: readJson(path.join(dir, 'artifacts.json'))?.artifacts ?? [],
    ledger: (l => (l ? { tag: l.tag ?? null, items: (l.items ?? []).map(({ id: n, name, kind, fixture, artifact, status, error, undoError, undo }) =>
      ({ id: n, name, kind, fixture: fixture ?? null, artifact: artifact ?? null, status, error: error ?? null, undoError: undoError ?? null, undo: undo ? (undo.steps ? 'steps' : 'hooks') : null })) } : null))(readJson(path.join(dir, 'ledger.json'))) };
}

// ---- jobs: CLI child processes, output streamed over SSE ----
const jobs = new Map();
const ALLOWED = new Set(['validate', 'render', 'run', 'doctor', 'generate', 'platform', 'login', 'session', 'snapshot', 'locate', 'try-step', 'export', 'import', 'suggest-fix', 'cleanup', 'reset']);
// import only reads files the UI saved itself (POST /api/upload-export), each in its own folder under out/.imports/
const importsDir = path.join(outDir, '.imports');
function startJob(args) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, args, lines: [], done: false, result: null, listeners: new Set(), startedAt: new Date().toISOString() };
  jobs.set(id, job);
  const child = spawn(process.execPath, [cli, ...args, '--json'], { cwd: root, env: { ...process.env, MSYS_NO_PATHCONV: '1', FORCE_COLOR: '0' } });
  job.child = child;
  const emit = (ev, data) => { for (const l of job.listeners) l(ev, data); };
  let stdout = '', partial = '';
  child.stdout.on('data', c => (stdout += c));
  child.stderr.on('data', c => {
    const parts = (partial + c).split(/\r?\n/); partial = parts.pop();
    for (const line of parts) { job.lines.push(line); emit('line', line); }
  });
  child.on('error', e => job.lines.push(String(e)));
  child.on('close', code => {
    if (partial) { job.lines.push(partial); emit('line', partial); }
    try { job.result = JSON.parse(stdout); } catch { job.result = { ok: code === 0, exitCode: code, raw: stdout.slice(-4000) }; }
    job.done = true; job.exitCode = code;
    emit('done', job.result);
  });
  return job;
}
const jobView = j => ({ id: j.id, args: j.args, startedAt: j.startedAt, done: j.done, exitCode: j.exitCode, result: j.result });

// ---- files ----
function serveFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  if (st.isDirectory()) return send(res, 404, { error: 'not found' });
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range && st.size) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${st.size}` });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// ---- routes ----
async function api(req, res, url) {
  const p = url.pathname, m = req.method, q = k => url.searchParams.get(k) ?? '';
  if (m === 'GET' && p === '/api/info') return send(res, 200, { root });
  if (m === 'GET' && p === '/api/platforms') return send(res, 200, listPlatforms());
  if (m === 'GET' && p === '/api/platform') {
    const d = platformDetail(q('name'));
    return d ? send(res, 200, d) : send(res, 404, { error: 'no such platform' });
  }
  if (p === '/api/pfile') {
    const rel = q('path'), f = platformFile(rel);
    if (!f) return send(res, 403, { error: 'only definition files under platforms/<name>/ (not dotfiles, auth state or node_modules)' });
    if (m === 'GET') return fs.existsSync(f) ? send(res, 200, { path: rel, text: fs.readFileSync(f, 'utf8') }) : send(res, 404, { error: 'not found' });
    if (m === 'PUT') {
      const { text, create } = await body(req);
      if (typeof text !== 'string') return send(res, 400, { error: 'text required' });
      if (create && fs.existsSync(f)) return send(res, 409, { error: `${rel} already exists` });
      if (f.endsWith('.json')) { try { JSON.parse(text); } catch (e) { return send(res, 400, { error: `not JSON: ${e.message}` }); } }
      writeAtomic(f, text);
      return send(res, 200, { saved: rel });
    }
  }
  // ---- clone / delete. Delete never erases: it moves the item under out/.trash/<stamp>/ (same relative path).
  if (m === 'POST' && p === '/api/clone') {
    const { kind, path: rel, name } = await body(req);
    if (kind === 'platform') {
      const src = within(platformsDir, String(rel ?? ''));
      if (!src || path.dirname(src) !== platformsDir || !isDir(src)) return send(res, 404, { error: 'no such app' });
      const to = freeName(platformsDir, name ?? `${path.basename(src)}-copy`, '');
      fs.cpSync(src, path.join(platformsDir, to), { recursive: true, filter: f => !path.basename(f).startsWith('.') || f === src });
      for (const f of walkFiles(path.join(platformsDir, to), `platforms/${to}`).filter(f => f.kind === 'tour' && f.path.endsWith('.json'))) {
        const file = path.join(root, f.path), t = readJson(file);
        if (t?.platform === path.basename(src)) { t.platform = to; writeAtomic(file, JSON.stringify(t, null, 2) + '\n'); }
      }
      return send(res, 200, { name: to, path: `platforms/${to}` });
    }
    const src = platformFile(rel);
    if (!src || !fs.existsSync(src)) return send(res, 404, { error: 'no such file' });
    const ext = /\.tour\.json$/.test(src) ? '.tour.json' : path.extname(src);
    const base = path.basename(src).slice(0, -ext.length);
    const to = freeName(path.dirname(src), name ?? `${base}-copy`, ext);
    const dest = path.join(path.dirname(src), to + ext);
    let text = fs.readFileSync(src, 'utf8');
    if (ext === '.tour.json') { const t = JSON.parse(text); if (t.name) t.name = to; text = JSON.stringify(t, null, 2) + '\n'; }
    writeAtomic(dest, text);
    return send(res, 200, { path: path.relative(root, dest).replaceAll('\\', '/') });
  }
  if (m === 'POST' && p === '/api/delete') {
    const { kind, path: rel } = await body(req);
    const target = kind === 'platform' ? (() => { const d = within(platformsDir, String(rel ?? '')); return d && path.dirname(d) === platformsDir && isDir(d) ? d : null; })()
      : kind === 'run' ? (() => { const d = within(outDir, String(rel ?? '')); return d && path.dirname(path.dirname(d)) === outDir && fs.existsSync(path.join(d, 'run.json')) ? d : null; })()
      : platformFile(rel);
    if (!target || !fs.existsSync(target)) return send(res, 404, { error: 'nothing to delete there' });
    if ([...jobs.values()].some(j => !j.done)) return send(res, 409, { error: 'something is still running; try again when it finishes' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(outDir, '.trash', stamp, path.relative(root, target));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(target, dest);
    return send(res, 200, { trashed: path.relative(root, dest).replaceAll('\\', '/') });
  }
  if (m === 'PUT' && p === '/api/secret') {
    // Saves one credential the platform references as {env:NAME} into the checkout's .env (git-ignored).
    // Write-only: no endpoint ever returns a value.
    const { platform, name, value } = await body(req);
    const d = platformDetail(String(platform ?? ''));
    if (!d) return send(res, 404, { error: 'no such platform' });
    if (!d.env.some(e => e.name === name)) return send(res, 403, { error: `${platform} doesn't use {env:${name}}` });
    if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) return send(res, 400, { error: 'one line of text, please' });
    const file = path.join(root, '.env');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
    const quoted = /^\s|\s$|^["']/.test(value) ? `"${value}"` : value;
    const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const i = lines.findIndex(l => re.test(l));
    if (i >= 0) lines[i] = `${name}=${quoted}`;
    else { if (lines.length && lines.at(-1) === '') lines.pop(); lines.push(`${name}=${quoted}`, ''); }
    writeAtomic(file, lines.join('\n'));
    return send(res, 200, { saved: name });
  }
  if (p === '/api/tour') {   // generated tours in run folders (out/**/tour.json)
    const rel = q('path'), f = within(root, rel);
    if (!f || !f.startsWith(outDir + path.sep) || !/tour\.json$/.test(f)) return send(res, 403, { error: 'only tour.json files under out/' });
    if (m === 'GET') return fs.existsSync(f) ? send(res, 200, { path: rel, text: fs.readFileSync(f, 'utf8') }) : send(res, 404, { error: 'not found' });
    if (m === 'PUT') {
      const { text } = await body(req);
      try { JSON.parse(text); } catch (e) { return send(res, 400, { error: `not JSON: ${e.message}` }); }
      writeAtomic(f, text);
      return send(res, 200, { saved: rel });
    }
  }
  if (m === 'GET' && p === '/api/runs') return send(res, 200, listRuns());
  if (m === 'GET' && p === '/api/run') {
    const d = runDetail(q('id'));
    return d ? send(res, 200, d) : send(res, 404, { error: 'no such run' });
  }
  if (m === 'GET' && p.startsWith('/api/file/')) {   // /api/file/<name>/<run>/<path in run>
    const f = within(outDir, decodeURIComponent(p.slice('/api/file/'.length)));
    return f ? serveFile(req, res, f) : send(res, 403, { error: 'outside out/' });
  }
  if (m === 'POST' && p === '/api/upload-export') {
    // an .aft.json dropped on the page: checked to be an export, then saved under out/.imports/<stamp>-<id>/ (never overwrites)
    const { name, text } = await body(req);
    let doc; try { doc = JSON.parse(text); } catch { return send(res, 400, { error: "That file isn't an exported script (it isn't JSON)." }); }
    if (doc?.schema !== 'aft-export/1') return send(res, 400, { error: "That file isn't an exported script (made with EXPORT, a .aft.json file)." });
    const base = String(name ?? 'script.aft.json').replace(/[^\w.-]+/g, '-').replace(/^\.+/, '') || 'script.aft.json';
    const dir = path.join(importsDir, `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, base.endsWith('.json') ? base : `${base}.json`);
    fs.writeFileSync(file, text);
    return send(res, 200, { file: path.relative(root, file), tour: doc.tour?.name ?? null, source: doc.source ?? {} });
  }
  if (m === 'GET' && p === '/api/jobs') return send(res, 200, [...jobs.values()].map(jobView).reverse());
  if (m === 'POST' && p === '/api/jobs') {
    const { args } = await body(req);
    if (!Array.isArray(args) || !args.every(a => typeof a === 'string') || !ALLOWED.has(args[0]))
      return send(res, 400, { error: `allowed commands: ${[...ALLOWED].join(', ')}` });
    if (args[0] === 'import' && !path.resolve(root, args[1] ?? '').startsWith(importsDir + path.sep))
      return send(res, 400, { error: 'import takes a file uploaded through /api/upload-export' });
    return send(res, 200, jobView(startJob(args)));
  }
  const jm = /^\/api\/jobs\/([a-f0-9]+)(\/events|\/stop)?$/.exec(p);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) return send(res, 404, { error: 'no such job' });
    if (m === 'POST' && jm[2] === '/stop') { job.child?.kill('SIGINT'); return send(res, 200, { stopping: true }); }
    if (jm[2] === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const write = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      for (const l of job.lines) write('line', l);
      if (job.done) { write('done', job.result); return res.end(); }
      const l = (ev, data) => { write(ev, data); if (ev === 'done') res.end(); };
      job.listeners.add(l);
      req.on('close', () => job.listeners.delete(l));
      return;
    }
    return send(res, 200, { ...jobView(job), lines: job.lines });
  }
  send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') === token) {
    res.writeHead(302, { 'set-cookie': `aft_ui=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
    return res.end();
  }
  const cookie = /(?:^|;\s*)aft_ui=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (cookie !== token) return send(res, 401, 'Open the URL printed by `node ui/server.mjs` (it carries the access token).', 'text/plain');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = within(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return f ? serveFile(req, res, f) : send(res, 404, { error: 'not found' });
  } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); }
});

server.listen(port, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${server.address().port}/?token=${token}`;
  console.log(`AutoFeatureTour UI: ${link}\n  data and CLI: ${root}`);
  if (!argv.includes('--no-open') && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', link], { detached: true, stdio: 'ignore' }).unref();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const j of jobs.values()) j.child?.kill('SIGINT'); process.exit(0); });
