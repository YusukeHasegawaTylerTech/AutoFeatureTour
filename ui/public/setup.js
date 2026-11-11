// First-run help on the start page: what this computer is missing (aft doctor) in plain words with a fix to press
// where there is one, and test data earlier runs left behind (ledger.json undo still pending) with one CLEAN UP button.

// Doctor's check names → [what it means, what to do, fix button or null, blocks making videos?]
const SETUP = [
  [/^Node\.js/, "This computer's Node.js is too old.", 'Run install.cmd again (it installs Node.js 22), then reopen this window.', null, true],
  [/^ffmpeg|^ffprobe/, "The video tool (ffmpeg) isn't installed.", 'Run install.cmd again (or: winget install Gyan.FFmpeg), then reopen this window.', null, true],
  [/^npm packages/, "The tool's own files are incomplete.", 'Run install.cmd again.', null, true],
  [/^Playwright Chromium/, "The browser that records the videos isn't installed yet.", 'Press INSTALL IT (a download of about 150 MB).', 'browser', true],
  [/^Speech/, 'No narrator voice is installed.', 'Videos will be silent, with the narration as captions. To add a voice: Windows Settings › Time & language › Speech.', null, false],
  [/^claude CLI/, "The AI helper (GENERATE) isn't installed.", 'Only needed to draft scenes from a story: install Claude Code, then sign in.', null, false],
  [/^claude signed in/, "The AI helper (GENERATE) isn't signed in.", 'Only needed to draft scenes from a story: open a terminal and run  claude auth login', null, false],
];

/** The machine check, cached for this browser tab (doctor takes a few seconds); ↻ CHECK AGAIN reruns it. */
export async function setupBanner(box, { h, send, runJob, force = false }) {
  let checks = null;
  try { if (!force) checks = JSON.parse(sessionStorage.getItem('aft-setup') ?? 'null'); } catch {}
  if (!checks) {
    box.innerHTML = '<p class="hint">Checking this computer…</p>';
    checks = await new Promise(res => runJob(['doctor'], { onDone: r => res(r.data?.checks ?? null) }).catch(() => res(null)));
    if (!checks) { box.innerHTML = ''; return; }
    sessionStorage.setItem('aft-setup', JSON.stringify(checks));
  }
  if (!box.isConnected) return;
  // only the machine's own checks: a platform's requirements show on that platform's page
  const problems = checks.filter(c => !c.ok && (c.group ?? 'engine') === 'engine').map(c => {
    const m = SETUP.find(([re]) => re.test(c.name));
    return m ? { text: m[1], fix: m[2], button: m[3], blocks: m[4] } : { text: c.name, fix: c.fix ?? '', button: null, blocks: !!c.required };
  });
  if (!problems.length) { box.innerHTML = ''; return; }
  const blocking = problems.some(x => x.blocks);
  box.innerHTML = `<div class="verdict ${blocking ? 'bad' : 'wait'} setup">${blocking ? '✘ This computer needs a little more before it can make videos' : 'ℹ Good to know'}
    <ul>${problems.map(x => `<li><b>${h(x.text)}</b> ${h(x.fix)}${x.button ? ` <button class="chunky small c-orange" data-fix="${x.button}">INSTALL IT</button>` : ''}</li>`).join('')}</ul>
    <div class="actions tight"><button class="chunky small c-gray" data-again>↻ CHECK AGAIN</button></div><small data-log></small></div>`;
  box.querySelector('[data-again]').onclick = () => setupBanner(box, { h, send, runJob, force: true });
  box.querySelectorAll('[data-fix=browser]').forEach(b => (b.onclick = async () => {
    b.disabled = true; b.textContent = '⏳ INSTALLING…';
    const logEl = box.querySelector('[data-log]');
    try {
      const job = await send('POST', '/api/setup/browser', {});
      const es = new EventSource(`/api/jobs/${job.id}/events`);
      es.addEventListener('line', e => { const l = JSON.parse(e.data).trim(); if (l && logEl) logEl.textContent = l.slice(-120); });
      es.addEventListener('done', () => { es.close(); setupBanner(box, { h, send, runJob, force: true }); });
    } catch (e) { b.textContent = `⚠ ${e.message}`; }
  }));
}

/** Test data runs created and never undid (a run cut short, a failed undo): one banner, one button (aft cleanup <run>). */
export async function leftoverBanner(box, { api, runJob }) {
  const c = await api('/api/cleanup-summary').catch(() => null);
  if (!box.isConnected) return;
  if (!c?.items) { box.innerHTML = ''; return; }
  const n = c.items, runs = c.runs.length;
  box.innerHTML = `<div class="verdict wait">🧹 ${n} piece${n === 1 ? '' : 's'} of test data ${n === 1 ? 'was' : 'were'} left behind by ${runs} earlier run${runs === 1 ? '' : 's'}
    <small>A run was stopped, or its clean-up failed. CLEAN UP NOW removes what those runs created in the app.</small>
    <div class="actions tight"><button class="chunky small c-orange" data-clean>🧹 CLEAN UP NOW</button></div><small data-msg></small></div>`;
  box.querySelector('[data-clean]').onclick = async e => {
    e.target.disabled = true; e.target.textContent = '⏳ CLEANING UP…';
    let failed = 0;
    for (const r of c.runs)
      await new Promise(res => runJob(['cleanup', `out/${r.id}`], { onDone: x => { if (!x.ok) failed++; res(); } }).catch(() => { failed++; res(); }));
    if (failed) {
      const apps = [...new Set(c.runs.map(r => r.id.split('/')[0]))].join(', ');
      box.querySelector('[data-msg]').textContent = `${failed} run(s) couldn't be cleaned up; the details are under ☰ › Platforms (${apps}).`;
      e.target.disabled = false; e.target.textContent = '🧹 TRY AGAIN';
    } else leftoverBanner(box, { api, runJob });
  };
}

/** Does this address look like a live site? (not localhost, a private IP, or a name with test/qa/dev/…) */
export function looksLive(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(host) || /\.(local|localhost|test|internal)$/.test(host)) return false;
  return !/(^|[.-])(test|testing|qa|dev|develop|staging|stage|stg|uat|sandbox|demo|preprod|sit|int)\d*([.-]|$)/.test(host);
}
