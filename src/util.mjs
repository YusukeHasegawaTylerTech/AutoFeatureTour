import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const num = n => String(Math.round(n * 1000) / 1000);

/**
 * Runs a program with an argument list (no shell unless asked); resolves with stdout when capture is set.
 * Rejects on a non-zero exit. Use shell: true only for Windows .cmd shims (npm, npx) with fixed arguments.
 */
export function run(exe, args = [], { cwd, env, capture = false, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd, env: env ?? process.env, shell, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let out = '';
    proc.stdout?.on('data', d => { out += d; });
    proc.on('error', reject);
    proc.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`${exe} exited with ${code}: ${args.join(' ')}`))));
  });
}

/** A sortable, collision-resistant run id: 20261104-143210-k3f9. */
export function runId(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Creates a fresh run folder that no other run uses. base/<runId> normally; with an explicit folder, that folder
 * if it's empty or missing, else a run-id subfolder inside it. mkdir without recursive on the leaf fails if another
 * process got there first, so concurrent runs can't share a folder.
 */
export function newRunDir(base, { explicit = false } = {}) {
  if (explicit && (!fs.existsSync(base) || !fs.readdirSync(base).length)) {
    fs.mkdirSync(base, { recursive: true });
    return path.resolve(base);
  }
  fs.mkdirSync(base, { recursive: true });
  for (;;) {
    const dir = path.join(base, runId());
    try { fs.mkdirSync(dir); return path.resolve(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

/** A TCP port that's free right now (the OS picks it), for private API/web servers. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Finds an executable on PATH (PATHEXT aware on Windows), or null. */
export function which(cmd) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return null;
}

/** Parses --key value, --flag and --key=value into an object with camelCased keys; positional args go in _. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    let k = eq < 0 ? a.slice(2) : a.slice(2, eq);
    let v = eq < 0 ? undefined : a.slice(eq + 1);
    k = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (v === undefined) v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    // --answer may be given more than once (aft converse): a list.
    out[k] = k === 'answer' && out[k] !== undefined ? [out[k], v].flat() : v;
  }
  return out;
}
