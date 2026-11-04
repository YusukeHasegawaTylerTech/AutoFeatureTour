// Recording primitives shared by every target: a Tour (browser session paced to the narration, with a visible
// cursor and per-scene timings), a static web server with an API proxy, and child-process helpers.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { log, sleep } from './util.mjs';

/** A red dot that follows the mouse and pulses on click (Playwright's video doesn't show the real cursor). */
function cursorScript() {
  const add = () => {
    if (document.getElementById('tour-cursor')) return;
    const c = document.createElement('div');
    c.id = 'tour-cursor';
    Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', width: '22px', height: '22px', margin: '-11px 0 0 -11px',
      borderRadius: '50%', background: 'rgba(229,57,53,.55)', border: '2px solid #fff', boxShadow: '0 0 6px rgba(0,0,0,.5)',
      pointerEvents: 'none', zIndex: 2147483647, transition: 'transform .12s' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.6)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
}

/**
 * One recorded browser session. Wrap each narrated scene in scene(id, fn) and pace actions with at(fraction of the
 * narration). Anything between scenes (seeding, waiting for jobs) is off camera and gets cut.
 */
export class Tour {
  constructor({ outDir, narration, viewport = { width: 1440, height: 810 } }) {
    this.outDir = outDir;
    this.narration = narration; // [{ id, seconds }]
    this.viewport = viewport;
    this.timings = [];
    this.current = null;
    this.t0 = 0;
  }

  /** Launches the browser and starts recording. initScripts: functions or [fn, arg] pairs run in every page. */
  async start({ initScripts = [], cursor = true, headless = true, storageState, trace = true } = {}) {
    fs.mkdirSync(this.outDir, { recursive: true });
    this.browser = await chromium.launch({ headless });
    // Video frames are CSS pixels (deviceScaleFactor isn't applied), so record at the viewport size and scale later.
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      recordVideo: { dir: this.outDir, size: this.viewport },
      ...(storageState ? { storageState } : {}), // a saved login (aft login), so tours never type credentials on camera
    });
    // Always trace: a failed run can be opened with `npx playwright show-trace <run>/trace.zip`.
    if (trace) { await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false }); this.tracing = true; }
    for (const s of initScripts) await (Array.isArray(s) ? this.context.addInitScript(s[0], s[1]) : this.context.addInitScript(s));
    if (cursor) await this.context.addInitScript(cursorScript);
    this.page = await this.context.newPage();
    this.page.on('dialog', d => d.accept());
    this.t0 = Date.now();
    return this.page;
  }

  now() { return (Date.now() - this.t0) / 1000; }

  /** Waits until this fraction of the current scene's narration has played. */
  async at(fraction) {
    const wait = (this.current.start + fraction * this.current.seconds - this.now()) * 1000;
    if (wait > 0) await sleep(wait);
  }

  async scene(id, fn) {
    const seconds = this.narration.find(n => n.id === id)?.seconds;
    if (!seconds) throw new Error(`No narration for ${id}`);
    await sleep(300); // let the page settle before the cut
    this.current = { id, seconds, start: this.now() };
    log(`${id} start (${seconds.toFixed(1)} s)`);
    await fn(this);
    await this.at(1);
    const end = this.now();
    this.timings.push({ id, start: +this.current.start.toFixed(3), end: +end.toFixed(3) });
    log(`${id} end (${(end - this.current.start).toFixed(1)} s)`);
    await this.screenshot(id);
  }

  async moveTo(target, { dx = 0.5, dy = 0.5, steps = 25 } = {}) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    if (!b) throw new Error('Element not visible');
    const x = b.x + b.width * dx, y = b.y + b.height * dy;
    await this.page.mouse.move(x, y, { steps });
    return { x, y };
  }

  async click(target, opts) {
    const { x, y } = await this.moveTo(target, opts);
    await sleep(250);
    await this.page.mouse.click(x, y);
    await sleep(300);
  }

  async typeInto(target, text, { delay = 45 } = {}) {
    await this.click(target);
    await target.fill('');
    await target.pressSequentially(text, { delay });
  }

  /** Mouse drag in page coordinates. */
  async drag(from, to, { steps = 30 } = {}) {
    await this.page.mouse.move(from.x, from.y, { steps: 25 });
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps });
    await this.page.mouse.up();
  }

  /** Opens a helper page and waits for it to set window.tourReady = true. */
  async helper(url, timeout = 60000) {
    await this.page.goto(url);
    await this.page.waitForFunction(() => window.tourReady === true, null, { timeout });
  }

  /** Stops recording and writes recording.webm and timings.json (plus any extra fields) to outDir. */
  async finish(extra = {}) {
    await sleep(500);
    const video = this.page.video();
    await this.saveTrace('trace.zip');
    await this.context.close();
    const recording = path.join(this.outDir, 'recording.webm');
    fs.rmSync(recording, { force: true });
    await video.saveAs(recording);
    await video.delete();
    fs.writeFileSync(path.join(this.outDir, 'timings.json'), JSON.stringify({ ...extra, scenes: this.timings }, null, 2));
    log(`recording: ${recording}`);
    return recording;
  }

  /** Saves a still of the current page (screens/<name>.png in outDir); handy for reviewing a run. */
  async screenshot(name) {
    const dir = path.join(this.outDir, 'screens');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await this.page.screenshot({ path: file }).catch(e => log(`screenshot ${name} failed: ${e.message}`));
    return file;
  }

  /** Stops tracing into outDir/name (once). Called by finish(), and by the CLI when a run fails. */
  async saveTrace(name = 'trace.zip') {
    if (!this.tracing) return null;
    this.tracing = false;
    const file = path.join(this.outDir, name);
    await this.context.tracing.stop({ path: file }).catch(e => log(`trace not saved: ${e.message}`));
    log(`trace: ${file}  (npx playwright show-trace "${file}")`);
    return file;
  }

  async close() { await this.browser?.close(); }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json' };

/** Resolves a URL path under root, or null if it escapes root or doesn't exist. */
function under(root, urlPath) {
  const base = path.resolve(root);
  const file = path.resolve(base, '.' + decodeURIComponent(urlPath));
  return (file === base || file.startsWith(base + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

/**
 * Serves a built SPA plus tour helper files, proxying an API prefix to another port.
 *   routes: [{ prefix: '/tour/', dir }] or [{ path: '/tour/scan.pdf', file }], matched in order
 *   spa:    dist folder; unknown paths fall back to its index.html
 *   proxy:  { prefix: '/api/', port }
 */
export function startStaticServer({ port, routes = [], spa, proxy }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (proxy && url.pathname.startsWith(proxy.prefix)) {
      const up = http.request({ host: 'localhost', port: proxy.port, path: req.url, method: req.method, headers: req.headers }, r => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', e => { res.writeHead(502); res.end(String(e)); });
      req.pipe(up);
      return;
    }
    let file;
    const route = routes.find(r => (r.path ? url.pathname === r.path : url.pathname.startsWith(r.prefix)));
    if (route) file = route.file ?? under(route.dir, url.pathname.slice(route.prefix.length - 1));
    else if (spa) file = under(spa, url.pathname) ?? path.join(spa, 'index.html');
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, () => r(server)));
}

/**
 * Starts a long-running process (an API, a dev server) with its output in logFile. With shell: true, exe is a whole
 * command line (for tour.json "launch" commands written by the app's own team).
 */
export function startProcess(exe, args = [], { env, cwd, logFile, shell = false }) {
  const proc = spawn(exe, args, { env: { ...process.env, ...env }, cwd, shell, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(logFile);
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.on('exit', code => { if (code) log(`${shell ? 'launch command' : path.basename(exe)} exited with ${code}; see ${logFile}`); });
  return proc;
}

/** Stops a process and its children (a shell's dev server, say). */
export function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill();
}

export async function waitForHttp(url, { ms = 60000, hint = '' } = {}) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${url} didn't come up${hint ? `; ${hint}` : ''}`);
}
