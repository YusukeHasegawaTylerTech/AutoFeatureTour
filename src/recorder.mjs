// Recording primitives shared by every target: a Tour (browser session paced to the narration, with a visible
// cursor and per-scene timings), a static web server with an API proxy, and child-process helpers.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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
 * Blurs sensitive data on screen before it's ever recorded (the video, screenshots and trace all see the blurred page).
 * mask.selectors: CSS for whole elements (e.g. ".ssn", "[data-pii]"); mask.patterns: regex sources matched in text
 * (e.g. "\b\d{3}-\d{2}-\d{4}\b"), wrapped in blurred spans as the page changes. A hook point, not a guarantee:
 * use demo data, and check the output.
 */
function maskScript(mask) {
  const blur = 'filter: blur(7px) !important;';
  const apply = () => {
    if (mask.selectors?.length && !document.getElementById('tour-mask-css')) {
      const st = document.createElement('style');
      st.id = 'tour-mask-css';
      st.textContent = mask.selectors.map(s => `${s} { ${blur} }`).join('\n');
      document.documentElement.appendChild(st);
    }
    if (!mask.patterns?.length) return;
    const re = new RegExp(mask.patterns.map(p => `(?:${p})`).join('|'), 'g');
    const walk = root => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n =>
        n.parentElement && !n.parentElement.closest('script, style, [data-tour-mask]') && re.test(n.data) ? 1 : 2 });
      const nodes = [];
      for (let n = tw.nextNode(); n; n = tw.nextNode()) nodes.push(n);
      for (const n of nodes) {
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const m of n.data.matchAll(re)) {
          frag.append(n.data.slice(last, m.index));
          const span = document.createElement('span');
          span.dataset.tourMask = '';
          span.style.cssText = blur;
          span.textContent = m[0];
          frag.append(span);
          last = m.index + m[0].length;
        }
        frag.append(n.data.slice(last));
        n.replaceWith(frag);
      }
      // Field values aren't text nodes: blur inputs whose value matches.
      for (const f of root.querySelectorAll?.('input, textarea') ?? []) { re.lastIndex = 0; f.style.filter = re.test(f.value) ? 'blur(7px)' : ''; }
    };
    walk(document.body);
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) walk(n.nodeType === 3 ? n.parentElement ?? document.body : n); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    for (const type of ['input', 'keyup', 'change']) document.addEventListener(type, e => { const f = e.target; if (f.matches?.('input, textarea')) { re.lastIndex = 0; f.style.filter = re.test(f.value) ? 'blur(7px)' : ''; } }, true); // keyup: Enter clears a field without an input event
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', apply); else apply();
}

/**
 * One recorded browser session. Wrap each narrated scene in scene(id, fn) and pace actions with at(fraction of the
 * narration). Anything between scenes (seeding, waiting for jobs) is off camera and gets cut.
 */
export class Tour {
  /**
   * dryRun: no video and no pacing; steps still run (later steps depend on earlier ones), so every target is checked.
   * headless: false shows the browser (debugging a tour). mask: PII to blur on screen; see maskScript.
   */
  constructor({ outDir, narration, viewport = { width: 1440, height: 810 }, dryRun = false, headless = true, mask } = {}) {
    this.dryRun = dryRun;
    this.headless = headless;
    this.mask = mask;
    this.outDir = outDir;
    this.narration = narration; // [{ id, seconds }]
    this.viewport = viewport;
    this.timings = [];
    this.current = null;
    this.t0 = 0;
    this.waits = []; // { start, end, reason } in recording seconds: ready / waitFor / waitForResponse / workaround
    this.notes = []; // { at, text }: on-screen known issues, shown as a caption
  }

  /** A wait the viewer sat through (inside a scene); long ones can be trimmed from the video (render.mjs). */
  markWait(reason, start, end) {
    if (!this.current || this.dryRun || !(end > start)) return;
    this.waits.push({ reason, start: +start.toFixed(3), end: +end.toFixed(3) });
  }

  /** A caption-worthy note at the current moment (a tolerated known issue on camera). */
  note(text) {
    if (!this.current || this.dryRun || this.notes.some(n => n.text === text && n.scene === this.current.id)) return;
    this.notes.push({ scene: this.current.id, at: +this.now().toFixed(3), text });
  }

  /** Launches the browser and starts recording. initScripts: functions or [fn, arg] pairs run in every page. */
  async start({ initScripts = [], cursor = true, headless = this.headless, storageState, trace = true, ignoreHTTPSErrors = false } = {}) {
    fs.mkdirSync(this.outDir, { recursive: true });
    this.browser = await chromium.launch({ headless });
    // Video frames are CSS pixels (deviceScaleFactor isn't applied), so record at the viewport size and scale later.
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      ...(this.dryRun ? {} : { recordVideo: { dir: this.outDir, size: this.viewport } }),
      ...(storageState ? { storageState } : {}), // a saved login (aft login), so tours never type credentials on camera
      ignoreHTTPSErrors, // dev/test servers with self-signed certificates
    });
    // Always trace: a failed run can be opened with `npx playwright show-trace <run>/trace.zip`.
    if (trace) { await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false }); this.tracing = true; }
    for (const s of initScripts) await (Array.isArray(s) ? this.context.addInitScript(s[0], s[1]) : this.context.addInitScript(s));
    if (cursor) await this.context.addInitScript(cursorScript);
    if (this.mask?.selectors?.length || this.mask?.patterns?.length) await this.context.addInitScript(maskScript, this.mask);
    this.page = await this.context.newPage();
    // Dialogs: accepted unless a "dialog" step planned otherwise (popups' dialogs too).
    this.page.on('dialog', d => this.handleDialog(d));
    this.context.on('page', p => { if (p !== this.page) p.on('dialog', d => this.handleDialog(d)); });
    // Browser-side evidence for the triage bundle (bounded, so a chatty app can't grow it without limit).
    this.consoleErrors = [];
    this.networkFailures = [];
    // Each entry records the step that was running (attribution); entries matching the tour's appErrors.ignore are
    // kept but marked "ignored", so known noisy endpoints don't count as causes.
    const ignore = (this.policy?.ignore ?? []).map(r => new RegExp(r, 'i'));
    const keep = (list, item) => {
      if (list.length >= 500) return {};
      const text = `${item.request ?? ''} ${item.text ?? ''}`;
      const entry = { at: +this.now().toFixed(2), url: this.page.url(), stepKey: this.stepKey ?? 'setup', step: this.stepLabel ?? null, ...item,
        ...(ignore.some(r => r.test(text)) ? { ignored: true } : {}) };
      list.push(entry);
      return entry;
    };
    this.page.on('crash', () => { this.crashed = true; keep(this.consoleErrors, { type: 'crash', text: 'the browser page crashed' }); });
    this.page.on('console', m => { if (['error', 'warning'].includes(m.type())) keep(this.consoleErrors, { type: m.type(), text: m.text().slice(0, 2000) }); });
    this.page.on('pageerror', e => keep(this.consoleErrors, { type: 'pageerror', text: String(e.stack ?? e).slice(0, 2000) }));
    this.page.on('requestfailed', r => keep(this.networkFailures, { method: r.method(), request: r.url(), failure: r.failure()?.errorText }));
    // An error response keeps the start of its body (redacted when written): a business-logic status such as 450 says
    // little without it.
    this.page.on('response', r => {
      if (r.status() < 400) return;
      const entry = keep(this.networkFailures, { method: r.request().method(), request: r.url(), status: r.status() });
      r.text().then(b => { if (b) entry.body = b.replace(/\s+/g, ' ').trim().slice(0, 500); }).catch(() => {});
    });
    this.t0 = Date.now();
    return this.page;
  }

  /** A fresh browser context (e.g. after re-login), before any scene: the old one and its video are discarded. */
  async restart(opts) {
    const old = this.page?.video();
    await this.context?.close().catch(() => {});
    await old?.delete().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.timings = [];
    this.waits = [];
    this.notes = [];
    return this.start(opts);
  }

  now() { return (Date.now() - this.t0) / 1000; }

  /** Waits until this fraction of the current scene's narration has played. */
  async at(fraction) {
    if (this.dryRun) return;
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
    const start = this.current.start;
    const inScene = x => x.start >= start && x.start < end;
    this.timings.push({ id, start: +start.toFixed(3), end: +end.toFixed(3),
      ...(this.waits.some(inScene) ? { waits: this.waits.filter(inScene) } : {}),
      ...(this.notes.some(n => n.scene === id) ? { notes: this.notes.filter(n => n.scene === id).map(({ at, text }) => ({ at, text })) } : {}),
      ...(this.mockedScenes?.has(id) ? { mocked: true } : {}) });
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

  /** Answers a dialog as the last "dialog" step said (default accept); a message that doesn't match "expect" fails the step. */
  async handleDialog(d) {
    const plan = this.dialogPlan;
    this.dialogPlan = null;
    if (plan?.expect !== undefined) {
      const re = String(plan.expect).match(/^\/(.+)\/([dgimsuy]*)$/);
      const ok = re ? new RegExp(re[1], re[2]).test(d.message()) : d.message().includes(plan.expect);
      if (!ok) this.dialogFailure = `the ${d.type()} said "${d.message().slice(0, 200)}", expected "${plan.expect}"`;
    }
    await (plan?.action === 'dismiss' ? d.dismiss() : d.accept(plan?.text)).catch(() => {});
  }

  async click(target, opts = {}) {
    const { button, clickCount, modifiers = [], ...move } = opts;
    let { x, y } = await this.moveTo(target, move);
    await sleep(250);
    // The click goes to a screen position (so the cursor is filmed), so check first that the element would get it:
    // not disabled, and not covered by an overlay, a dialog or a spinner.
    if (!(await target.isEnabled().catch(() => true))) throw new Error('action blocked: the element is disabled');
    let cover = await coveredBy(target, x, y);
    // Scrolling "into view" stops at the viewport's edge, where a fixed or sticky header/footer can sit on top of
    // the element. Then bring it to the middle of the screen and look again; a real overlay still blocks.
    if (cover?.pinned) {
      await target.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
      await sleep(300);
      ({ x, y } = await this.moveTo(target, move));
      cover = await coveredBy(target, x, y);
    }
    // Covered by a known issue (a workaround's popup): dismiss it and look again. A tolerated one that really covers
    // the target still blocks.
    if (cover && !cover.detached && this.workarounds?.any && await this.workarounds.checkpoint(this)) {
      ({ x, y } = await this.moveTo(target, move));
      cover = await coveredBy(target, x, y);
    }
    if (cover) throw new Error(`action blocked: ${cover.detached ? '(element detached from the page)' : `the element is covered by ${cover.by}`}`);
    for (const m of modifiers) await this.page.keyboard.down(m);
    await this.page.mouse.click(x, y, { button, clickCount });
    for (const m of [...modifiers].reverse()) await this.page.keyboard.up(m);
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
    if (this.dryRun) {
      await this.saveTrace('trace.zip');
      await this.context.close();
      fs.writeFileSync(path.join(this.outDir, 'timings.json'), JSON.stringify({ ...extra, dryRun: true, scenes: this.timings }, null, 2));
      return null;
    }
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
    const mask = (this.mask?.selectors ?? []).map(s => this.page.locator(s)); // PII also masked by Playwright, on top of the in-page blur
    await this.page.screenshot({ path: file, mask, timeout: 10000 }).catch(e => log(`screenshot ${name} failed: ${e.message}`));
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

/**
 * What would get a click at (x, y) instead of the element: null if the element would, else { by, pinned } (pinned: the
 * covering element or one of its ancestors is position fixed/sticky, i.e. a header, footer or toolbar that scrolling can
 * move the element out from under), or { detached } if the element left the page.
 */
async function coveredBy(target, x, y) {
  return target.evaluate((el, [px, py]) => {
    const hit = document.elementFromPoint(px, py);
    if (!hit || el === hit || el.contains(hit) || hit.contains(el) || (el.getRootNode?.() !== document && el.getRootNode().host?.contains(hit))) return null;
    const d = n => `<${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${n.className && typeof n.className === 'string' ? `.${n.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}>`;
    let pinned = false;
    for (let n = hit; n && n !== document.body; n = n.parentElement) if (/fixed|sticky/.test(getComputedStyle(n).position)) { pinned = true; break; }
    // A modal backdrop is fixed too, but covers the whole screen: scrolling can't help, so it isn't "pinned".
    if (pinned) { const r = hit.getBoundingClientRect(); if (r.width * r.height > 0.6 * innerWidth * innerHeight) pinned = false; }
    return { by: d(hit), pinned };
  }, [x, y]).catch(e => (/detached|not attached/i.test(e.message) ? { detached: true } : null));
}

/** The last lines of a log, indented for an error message ('' if there's no log). */
export function logTail(file, lines = 12) {
  if (!file || !fs.existsSync(file)) return '';
  const tail = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(-lines);
  return tail.length ? `\n  last lines of the log:\n${tail.map(l => `    ${l.slice(0, 300)}`).join('\n')}` : '';
}

/** Stops a process and its children (a shell's dev server, say). */
export function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill();
}

/**
 * True if url answers. any: any HTTP status counts (a 401/404 still means the server is up); otherwise 2xx/3xx.
 * Self-signed certificates are accepted: this only checks a dev or test server is listening.
 */
export function probe(url, { any = false, timeout = 3000 } = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', timeout, rejectUnauthorized: false }, res => {
      res.resume();
      resolve(any ? true : res.statusCode < 400);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Waits until url answers. With proc (a launched process), stops waiting as soon as it exits
 * with an error code, and quotes the last lines of its logFile, instead of waiting out the timeout for a server that already crashed.
 */
export async function waitForHttp(url, { ms = 60000, hint = '', any = false, proc, logFile, label = 'launch command' } = {}) {
  let until = Date.now() + ms;
  const hardStop = Date.now() + ms * 3;
  const size = () => { try { return fs.statSync(logFile).size; } catch { return -1; } };
  let lastSize = logFile ? size() : -1, grewAt = Date.now(), extended = false;
  for (;;) {
    // A service still writing to its log is still starting (a dev server compiling): keep waiting, up to 3× the
    // timeout, instead of failing while it works.
    if (logFile) { const s = size(); if (s !== lastSize) { lastSize = s; grewAt = Date.now(); } }
    if (Date.now() >= until) {
      if (logFile && Date.now() - grewAt < 60000 && Date.now() < hardStop) {
        if (!extended) log(`${label}: not answering after ${Math.round(ms / 1000)}s, but its log is still growing; waiting longer`);
        extended = true;
        until = Date.now() + 30000;
      } else break;
    }
    if (await probe(url, { any })) return;
    // Exit code 0 can be a launcher that started the server in the background (docker compose up -d): keep waiting.
    if (proc && proc.exitCode !== null && proc.exitCode !== 0) {
      await sleep(300); // let the log stream flush
      throw new Error(`${url} didn't come up: ${label} exited with code ${proc.exitCode} before it answered${logFile ? `; see ${logFile}` : ''}${logTail(logFile)}`);
    }
    await sleep(1000);
  }
  const still = extended && Date.now() - grewAt < 60000;
  throw new Error(`${url} didn't come up${still ? ` (${label} is still starting: its log is still growing; raise the launch's "timeoutSeconds", now ${Math.round(ms / 1000)})` : ''}${hint ? `; ${hint}` : ''}`);
}
