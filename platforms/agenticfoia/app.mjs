// AgenticFOIA target: building and launching a private copy of the app, its API, and helpers the tours share.
// Only synthetic data is used: AgenticFOIA's Data/test-corpus and files generated here.
//
// Target options (CLI flags): --app-repo <path to AgenticFOIA> (default: ../AgenticFOIA next to this repo, or
// AFT_AGENTICFOIA_REPO), --engine <ClaudeCli|Placeholder|Http> (default ClaudeCli; synthetic data only),
// --api-port / --web-port (default: free ports), --skip-build, --whisper-model, --vad-model, --tesseract, --detection-models
// (default: the AGENTICFOIA_Media__* environment variables the AgenticFOIA CLI uses).

import fs from 'node:fs';
import path from 'node:path';
import { startProcess, startStaticServer, waitForHttp } from '../../src/recorder.mjs';
import { freePort, run, sleep, which } from '../../src/util.mjs';

export const REVIEWER = 'J. Alvarez (Records)';
export const pronounce = { 'Agentic FOIA': 'Agentic Foya', FOIA: 'Foya' };

export async function settings(ctx) {
  const o = ctx.options;
  const repo = path.resolve(o.appRepo ?? process.env.AFT_AGENTICFOIA_REPO ?? path.join(ctx.toolRoot, '..', 'AgenticFOIA'));
  if (!fs.existsSync(path.join(repo, 'AgenticFOIACompute'))) throw new Error(`AgenticFOIA repo not found at ${repo}; pass --app-repo`);
  // Free ports by default, so concurrent runs (and your own dev servers) never clash.
  const apiPort = Number(o.apiPort ?? await freePort()), webPort = Number(o.webPort ?? await freePort());
  return {
    repo, apiPort, webPort,
    engine: o.engine ?? 'ClaudeCli',
    skipBuild: !!o.skipBuild,
    api: `http://localhost:${apiPort}/api`,
    web: `http://localhost:${webPort}`,
    corpus: path.join(repo, 'Data', 'test-corpus'),
    media: {
      WhisperModel: o.whisperModel ?? process.env.AGENTICFOIA_Media__WhisperModel,
      VadModel: o.vadModel ?? process.env.AGENTICFOIA_Media__VadModel,
      Tesseract: o.tesseract ?? process.env.AGENTICFOIA_Media__Tesseract,
      DetectionModels: o.detectionModels ?? process.env.AGENTICFOIA_Media__DetectionModels,
    },
  };
}

export function findTesseract(s) {
  const t = [s.media.Tesseract, which('tesseract'), `${process.env.ProgramFiles}\\Tesseract-OCR\\tesseract.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Tesseract-OCR\\tesseract.exe`].find(f => f && fs.existsSync(f));
  if (!t) throw new Error('Tesseract not found; pass --tesseract <path to tesseract.exe>');
  s.media.Tesseract = t;
}

/** Release builds of the API and web app (Release, so a Debug API you have running and its locked DLLs are left alone). */
export async function build(ctx, s) {
  const apiExe = path.join(s.repo, 'AgenticFOIACompute', 'src', 'AgenticFOIA.Api', 'bin', 'Release', 'net10.0',
    process.platform === 'win32' ? 'AgenticFOIA.Api.exe' : 'AgenticFOIA.Api');
  const webDir = path.join(s.repo, 'AgenticFOIAWeb');
  const webDist = path.join(webDir, 'dist', 'AgenticFOIAWeb', 'browser');
  if (!s.skipBuild || !fs.existsSync(apiExe))
    await run('dotnet', ['build', path.join(s.repo, 'AgenticFOIACompute', 'src', 'AgenticFOIA.Api'), '-c', 'Release', '-v', 'q', '-nologo']);
  if (!s.skipBuild || !fs.existsSync(webDist))
    await run('npx', ['ng', 'build'], { cwd: webDir, shell: process.platform === 'win32' });
  return { apiExe, webDist };
}

/** A fresh data folder for every run, with the client rules the API reads, so your own projects never appear. */
export function freshData(ctx, s) {
  const dataRoot = path.join(ctx.outDir, 'data');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
  fs.cpSync(path.join(s.repo, 'Data', 'client-rules'), path.join(dataRoot, 'client-rules'), { recursive: true });
  return dataRoot;
}

/** Starts the private API and the web server (built SPA + tour pages + /api proxy). Returns a stop function. */
export async function launch(ctx, s, { apiExe, webDist, dataRoot, routes = [] }) {
  const env = {
    ASPNETCORE_URLS: `http://localhost:${s.apiPort}`,
    ASPNETCORE_ENVIRONMENT: 'Production',
    Storage__RootPath: dataRoot,
    Redaction__DefaultEngine: s.engine,
    Cors__AllowedOrigins__0: s.web,
  };
  for (const [k, v] of Object.entries(s.media)) if (v) env[`Media__${k}`] = v;
  const logFile = path.join(ctx.outDir, 'api.log');
  const apiProc = startProcess(apiExe, [], { env, cwd: path.dirname(apiExe), logFile });
  const server = await startStaticServer({
    port: s.webPort,
    proxy: { prefix: '/api/', port: s.apiPort },
    spa: webDist,
    routes: [
      ...routes,
      { prefix: '/tour/pdfjs/', dir: path.join(ctx.toolRoot, 'node_modules', 'pdfjs-dist', 'build') },
      { prefix: '/tour/', dir: path.join(ctx.platformDir, 'pages') },
    ],
  });
  const stop = () => { server.close(); apiProc.kill(); };
  try {
    await waitForHttp(`http://localhost:${s.apiPort}/health`, { hint: `see ${logFile}` });
  } catch (e) { stop(); throw e; }
  ctx.log('API and web server up');
  return stop;
}

export function client(s) {
  const api = async (method, url, body) => {
    const res = await fetch(s.api + url, {
      method,
      headers: { 'X-Reviewer': REVIEWER, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  const view = (p, d) => api('GET', `/projects/${p}/documents/${d}`);
  return {
    api,
    view,
    async docId(p, name) {
      const d = (await api('GET', `/projects/${p}`)).documents.find(x => x.metadata.originalFileName === name);
      if (!d) throw new Error(`${name} isn't in the project`);
      return d.metadata.documentId;
    },
    async approveRest(p, d) {
      const left = pending(await view(p, d));
      if (left.length) await api('POST', `/projects/${p}/documents/${d}/decisions`, left.map(i => ({ findingId: i.id, decision: 'Approved' })));
    },
    /** Waits until count files are analyzed; returns the project's documents. */
    async waitForAnalysis(p, count, ms = 30 * 60000) {
      const until = Date.now() + ms;
      for (;;) {
        const { documents } = await api('GET', `/projects/${p}`);
        const done = documents.filter(d => d.counts.pending >= 0);
        if (documents.length >= count && done.length === documents.length) return documents;
        if (Date.now() > until) throw new Error(`Analysis didn't finish: ${done.length}/${count} files done`);
        await sleep(2500);
      }
    },
  };
}

/** The item's own "✔ Approve" button, not the "approve all" hint that can appear beside it. */
export const APPROVE = /^\W*Approve\s*$/;

export const pending = v => v.items.filter(i => !i.decision);
export const isText = i => (i.finding.kind ?? 'Text') === 'Text';

export const reviewerInit = [name => localStorage.setItem('agenticfoia.reviewer', name), REVIEWER];

export function manifest(s) {
  return JSON.parse(fs.readFileSync(path.join(s.corpus, 'manifest.json'), 'utf8'));
}

/** Creates a project from the home page and drops files on the upload zone (shared by both tours' scene 2). */
export async function createProjectAndUpload(t, projectName, files, { uploadAt, pointAt }) {
  const page = t.page;
  await t.click(page.locator('#add-project'));
  await t.typeInto(page.locator('.queue-new input'), projectName);
  await t.click(page.locator('.queue-new forge-button[type=submit]'));
  await page.waitForURL(/\/projects\/[A-Za-z0-9_-]+$/);
  const projectId = page.url().split('/').pop();
  await t.at(uploadAt);
  // "Drop in the files": hover the drop zone as if dragging, then hand the files to its input.
  const zone = page.locator('label.dropzone');
  await t.moveTo(zone, { steps: 35 });
  await zone.evaluate(el => el.classList.add('over'));
  await sleep(900);
  await zone.evaluate(el => el.classList.remove('over'));
  await page.locator('label.dropzone input[type=file]').setInputFiles(files);
  await t.at(pointAt);
  await t.moveTo(page.locator('table.table tbody tr').last(), { dx: 0.3, steps: 40 });
  return projectId;
}

/** Picks review actions from the manifest: an item to approve, a "keep" value to deny, a missed value to add. */
export function pickReview(v, truth) {
  const keep = (truth?.keep ?? []).map(k => k.text ?? k);
  const items = pending(v).filter(isText);
  const deny = items.find(i => keep.some(k => i.finding.originalText.includes(k) || k.includes(i.finding.originalText)));
  const covered = t => v.items.some(i => i.finding.originalText.includes(t) || t.includes(i.finding.originalText));
  const missed = (truth?.redact ?? []).find(r => !covered(r.text) && v.segments.some(s => s.text.includes(r.text)));
  return { items, deny, manual: missed ? { text: missed.text, category: missed.category } : null };
}

export async function denyItem(t, item, note = 'Officer name, public record') {
  await t.click(t.page.locator(`#item-${item.id}`));
  await t.typeInto(t.page.locator(`#item-${item.id} .item-actions input`), note);
  await t.click(t.page.locator(`#item-${item.id} forge-button`, { hasText: 'Deny' }));
}

export async function addManual(t, manual) {
  await selectText(t, manual.text);
  await t.typeInto(t.page.locator('.selection-bar input[placeholder=Category]'), manual.category);
  await t.typeInto(t.page.locator('.selection-bar input[placeholder=Reason]'), 'Missed by the engine');
  await t.click(t.page.locator('.selection-bar forge-button', { hasText: 'Add redaction' }));
}

/** Drags across the first occurrence of text in the review page's document, then pins the exact selection. */
export async function selectText(t, text) {
  const page = t.page;
  const box = await page.evaluate(txt => {
    for (const pre of document.querySelectorAll('section.doc pre.text')) {
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let full = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, full.length]); full += n.data; }
      const at = full.indexOf(txt);
      if (at < 0) continue;
      const locate = pos => { const [n, s] = nodes.findLast(([, s]) => s <= pos); return [n, pos - s]; };
      const range = document.createRange();
      range.setStart(...locate(at));
      range.setEnd(...locate(at + txt.length));
      window.__tourRange = range;
      range.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const r = range.getClientRects();
      const a = r[0], b = r[r.length - 1];
      return { sx: a.left + 1, sy: a.top + a.height / 2, ex: b.right - 1, ey: b.top + b.height / 2 };
    }
    return null;
  }, text);
  if (!box) throw new Error(`"${text}" not found in the document`);
  await sleep(400);
  await t.drag({ x: box.sx, y: box.sy }, { x: box.ex, y: box.ey });
  await page.evaluate(() => {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(window.__tourRange);
    document.querySelector('section.doc').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await sleep(400);
}
