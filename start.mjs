#!/usr/bin/env node
// Starts the AutoFeatureTour UI: reuses the UI server if one is already running for this checkout, else starts one
// (hidden, with --exit-with-ui), then opens the UI in its own app window (Edge or Chrome --app; else the default browser).
// A server started here stops on its own once every UI window has been closed (and no job is running).
//
//   start.cmd                 (Windows: double-click)
//   node start.mjs [--port 4777] [--no-window]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(root, '.sessions', 'ui.json');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** The running server for this checkout, if it answers. */
async function running() {
  const s = readState();
  if (!s?.pid || !pidAlive(s.pid)) return null;
  const ok = await fetch(`http://127.0.0.1:${s.port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  return ok ? s : null;
}

async function startServer() {
  const args = [path.join(root, 'ui', 'server.mjs'), '--no-open', '--exit-with-ui', ...(opt('--port') ? ['--port', opt('--port')] : [])];
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  const log = fs.openSync(path.join(root, 'out', 'ui-server.log'), 'a');
  const before = readState()?.startedAt;
  const child = spawn(process.execPath, args, { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const s = readState();
    if (s && s.pid === child.pid && s.startedAt !== before) return s;
    if (child.exitCode !== null) break;
  }
  throw new Error(`the UI server didn't start: see ${path.join(root, 'out', 'ui-server.log')}`);
}

/** Edge or Chrome, for an app window (no tabs or address bar). */
function appBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === 'win32'
    ? pf.flatMap(d => [path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')])
    : process.platform === 'darwin'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(f => fs.existsSync(f)) ?? null;
}

function openWindow(url) {
  const exe = appBrowser();
  if (exe) {
    // Its own profile, so the window is a separate browser process and sizes/positions are remembered for the UI only.
    const profile = path.join(root, '.sessions', 'ui-window');
    spawn(exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,900'],
      { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

try {
  let s = await running();
  if (s) console.log(`AutoFeatureTour UI already running (pid ${s.pid}, port ${s.port})`);
  else { s = await startServer(); console.log(`AutoFeatureTour UI started (pid ${s.pid}, port ${s.port}); it stops when its last window is closed`); }
  if (!argv.includes('--no-window')) openWindow(s.url);
  else console.log(s.url);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
