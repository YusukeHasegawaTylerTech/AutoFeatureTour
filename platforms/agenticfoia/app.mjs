// AgenticFOIA target: building and launching a private copy of the app, its API, and helpers the tours share.
// Only synthetic data is used: AgenticFOIA's Data/test-corpus and files generated here.
//
// Target options (CLI flags): --app-repo <path to AgenticFOIA> (default: ../AgenticFOIA next to this repo, or
// AFT_AGENTICFOIA_REPO), --engine <ClaudeCli|Placeholder|Http> (default ClaudeCli; synthetic data only),
// --api-port / --web-port (default: free ports), --skip-build, --whisper-model, --vad-model, --tesseract, --detection-models
// (default: the AGENTICFOIA_Media__* environment variables the AgenticFOIA CLI uses, else, for the models,
// models/agenticfoia/ggml-base.bin, silero_vad.onnx and detection/ in this repo, git-ignored, if present),
// --face-photo (pdf-ocr, full), --scan-file / --form-truth (full).

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
      WhisperModel: o.whisperModel ?? process.env.AGENTICFOIA_Media__WhisperModel ?? localModel(ctx, 'ggml-base.bin'),
      VadModel: o.vadModel ?? process.env.AGENTICFOIA_Media__VadModel ?? localModel(ctx, 'silero_vad.onnx'),
      Tesseract: o.tesseract ?? process.env.AGENTICFOIA_Media__Tesseract,
      DetectionModels: o.detectionModels ?? process.env.AGENTICFOIA_Media__DetectionModels ?? localModel(ctx, 'detection'),
    },
  };
}

/** The default model location, <toolRoot>/models/agenticfoia/<name> (git-ignored), if it exists. */
export function localModel(ctx, name) {
  const f = path.join(ctx.toolRoot, 'models', 'agenticfoia', name);
  return fs.existsSync(f) ? f : undefined;
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

/**
 * A fresh data folder for every run, so your own reviews never appear. The rules ship with the API build; a local
 * Data/client-rules override in the AgenticFOIA repo is copied only if there is one.
 */
export function freshData(ctx, s) {
  const dataRoot = path.join(ctx.outDir, 'data');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataRoot, 'reviews'), { recursive: true });
  const rules = path.join(s.repo, 'Data', 'client-rules');
  if (fs.existsSync(rules)) fs.cpSync(rules, path.join(dataRoot, 'client-rules'), { recursive: true });
  return dataRoot;
}

/** Throws unless the whisper and Silero VAD models are set (tours with audio or video). */
export function requireSpeechModels(s) {
  for (const k of ['WhisperModel', 'VadModel'])
    if (!s.media[k] || !fs.existsSync(s.media[k])) throw new Error(`--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).slice(1)} (or AGENTICFOIA_Media__${k}) must point to the model file`);
}

/** Synthetic media from make-media.ps1 (evidence photo, 911 call, body-camera video); returns { dir, info }. */
export async function makeMedia(ctx) {
  const dir = path.join(ctx.outDir, 'media');
  await ctx.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.platformDir, 'make-media.ps1'), '-OutDir', dir]);
  return { dir, info: JSON.parse(fs.readFileSync(path.join(dir, 'media.json'), 'utf8')) };
}

export const SCAN_SOURCE = '014-witness-statement.pdf';
export const SCAN_NAME = '014-witness-statement-scanned.pdf';

/**
 * A two-page synthetic scan in the run folder (make-scan.cs --form): page 1 is SCAN_SOURCE rendered and tilted, page 2
 * a form with tables and two ID photos cropped from facePhoto (read where it is). Its ground truth goes to
 * form-truth.json beside it, so the full tour can reuse the pair. Returns { scanFile, formTruth }.
 */
export async function makeScan(ctx, s, facePhoto) {
  if (!facePhoto || !fs.existsSync(facePhoto)) throw new Error(`--face-photo must point to an image with two portraits${facePhoto ? ` (not found: ${facePhoto})` : ''}`);
  const scanFile = path.join(ctx.outDir, SCAN_NAME), formTruth = path.join(ctx.outDir, 'form-truth.json');
  await ctx.run('dotnet', ['run', path.join(ctx.platformDir, 'make-scan.cs'), '--', path.join(s.corpus, SCAN_SOURCE), scanFile,
    '--form', path.resolve(facePhoto), formTruth]);
  return { scanFile, formTruth };
}

/** Ground truth of the scan: page 1 is the corpus file's, page 2 (tables and photos) from form-truth.json. */
export function loadScanTruth(s, formTruth) {
  const p1 = manifest(s).files.find(f => f.file === SCAN_SOURCE) ?? { redact: [], keep: [] };
  const form = JSON.parse(fs.readFileSync(formTruth, 'utf8'));
  return { redact: [...p1.redact, ...form.redact], keep: [...p1.keep, ...form.keep], photos: form.photos ?? [] };
}

/** Throws unless the detection models folder is set. */
export function requireDetection(s) {
  if (!s.media.DetectionModels || !fs.existsSync(s.media.DetectionModels))
    throw new Error('--detection-models (or AGENTICFOIA_Media__DetectionModels) must point to the detection models folder');
}

// ---- Mock RMS (the record-request tours) --------------------------------------------------------------------------

/** The two referenced records on the RMS tours' record request; caseExtra: absolute paths added to the case (a scan). */
export function rmsRecords({ caseExtra = [] } = {}) {
  return [
    { type: 'Incident', number: 'I26-004041', address: '1400 block of Example Ave', subject: 'Burglary, residential',
      corpusFiles: ['008-incident-report.txt', '006-incident-report.pdf', '074-cad-call-log.csv'],
      mediaFiles: ['evidence-note.png', '911-call.mp3', 'bodycam-unit12.mp4'] },
    { type: 'Case', number: 'C26-002053', address: null, subject: 'Follow-up investigation',
      corpusFiles: ['009-sexual-assault-report.docx', '022-internal-email.eml'], otherFiles: caseExtra },
  ];
}

export const recordFileCount = records =>
  records.reduce((n, r) => n + ['corpusFiles', 'mediaFiles', 'otherFiles'].reduce((m, k) => m + (r[k]?.length ?? 0), 0), 0);

/** Puts each record's attachments where the Mock RMS keeps them (<dataRoot>/rms-mock/records/<type>/<number>/). Before launch. */
export function placeRecords(dataRoot, records, { corpus, mediaDir }) {
  for (const rec of records) {
    const dir = path.join(dataRoot, 'rms-mock', 'records', rec.type, rec.number);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of rec.corpusFiles ?? []) fs.copyFileSync(path.join(corpus, f), path.join(dir, f));
    for (const f of rec.mediaFiles ?? []) fs.copyFileSync(path.join(mediaDir, f), path.join(dir, f));
    for (const f of rec.otherFiles ?? []) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
}

/**
 * Creates the record requests through the Mock RMS API (in RMS they already exist): three fictional ones so the grid
 * looks like a work queue, then the tour's request referencing the records. Returns { requestId, requestNumber }.
 */
export async function seedRequests(s, records, { details = 'All reports, statements, photos, 911 audio and body camera video for' } = {}) {
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const { api } = client(s, 'Mock RMS seed');
  for (const [first, last, typeId, ago] of [['Rowan', 'Petrakis', 2, 9], ['Marisol', 'Ventura', 3, 6], ['Priya', 'Hollister', 5, 4]]) {
    await api('POST', '/record-requests', { firstName: first, lastName: last, typeId, requestedDate: day(-ago), dueDate: day(10 - ago), assignedToId: 2,
      contactInformationTypeId: 1, contactInformationValue: `${first.toLowerCase()}@example.com`, details: 'Copies of the incident report.' });
  }
  const { recordRequestId } = await api('POST', '/record-requests', {
    firstName: 'Avery', lastName: 'Quinlan', typeId: 1, requestedDate: day(-2), dueDate: day(8), assignedToId: 1,
    contactInformationTypeId: 1, contactInformationValue: 'avery.quinlan@example.com',
    details: `${details} ${records.map(x => x.number).join(' and ')}.`,
    referencedRecords: records.map(x => ({ usageTypeId: x.type, number: x.number, address: x.address, subjectName: x.subject })),
  });
  const { general } = await api('GET', `/record-requests/${recordRequestId}`);
  return { requestId: recordRequestId, requestNumber: general.requestNumber };
}

/** API client for a record request's redaction review (the /reviews API). Call useReview() once the review is started. */
export function reviewClient(s, requestId) {
  const { api } = client(s);
  let reviewId;
  const R = () => { if (!reviewId) throw new Error('no review yet; call useReview()'); return `/reviews/${reviewId}`; };
  const docs = () => api('GET', R()).then(x => x.documents);
  const view = d => api('GET', `${R()}/documents/${d}`);
  const c = {
    api, docs, view, R,
    get reviewId() { return reviewId; },
    /** Picks up the request's current review (after "Start redaction review"). */
    async useReview() {
      const list = await api('GET', `/record-requests/${requestId}/reviews`);
      reviewId = (list.find(x => x.review.isCurrent) ?? list[0])?.review.reviewId;
      if (!reviewId) throw new Error('the record request has no review');
      return reviewId;
    },
    requestPage: (q = '') => `${s.web}/record-requests/${requestId}${q}`,
    docPage: d => `${s.web}/record-requests/${requestId}/reviews/${reviewId}/documents/${d}`,
    /** The document's API path as the web server proxies it, for the helper pages. */
    docApi: d => `/api${R()}/documents/${d}`,
    async docId(name) {
      const d = (await docs()).find(x => x.metadata.originalFileName === name);
      if (!d) throw new Error(`${name} isn't in the review`);
      return d.metadata.documentId;
    },
    async approveRest(d) {
      const left = pending(await view(d));
      if (left.length) await api('POST', `${R()}/documents/${d}/decisions`, left.map(i => ({ findingId: i.id, decision: 'Approved' })));
    },
    /** Adds by hand every occurrence of a ground-truth value the engine missed. */
    async addMissed(d, redact) {
      const v = await view(d);
      const spans = v.items.filter(i => isText(i) && i.decision?.decision !== 'Denied')
        .map(i => ({ seg: i.finding.segmentId, s: i.finding.start, e: i.finding.start + i.finding.length }));
      const covers = (seg, a, b) => spans.some(x => x.seg === seg && x.s <= a && x.e >= b);
      for (const r of redact)
        for (const seg of v.segments)
          for (let at = seg.text.indexOf(r.text); at >= 0; at = seg.text.indexOf(r.text, at + r.text.length))
            if (!covers(seg.id, at, at + r.text.length)) {
              await api('POST', `${R()}/documents/${d}/redactions`,
                { segmentId: seg.id, start: at, length: r.text.length, category: r.category, reason: 'Missed by the engine' });
              spans.push({ seg: seg.id, s: at, e: at + r.text.length });
            }
    },
    async waitForAnalysis(count, ms = 30 * 60000) {
      const until = Date.now() + ms;
      for (;;) {
        const ds = await docs();
        const done = ds.filter(d => d.counts.pending >= 0);
        if (ds.length >= count && done.length === ds.length) return ds;
        if (Date.now() > until) throw new Error(`Analysis didn't finish: ${done.length}/${count} files done`);
        await sleep(3000);
      }
    },
    /** Off camera: every file but skip is finished (redactFor(name) values added by hand, the rest approved) and exported. */
    async finishAndExport(skip, { redactFor = () => [], log } = {}) {
      for (const d of await docs()) {
        const id = d.metadata.documentId, name = d.metadata.originalFileName;
        if (id === skip) continue;
        const redact = redactFor(name) ?? [];
        if (redact.length) await c.addMissed(id, redact);
        await c.approveRest(id);
        log?.(`exporting ${name}…`);
        await api('POST', `${R()}/documents/${id}/export`);
      }
      const { blockers } = await api('GET', `${R()}/packet`);
      if (blockers.length) throw new Error(`Packet still blocked: ${blockers.join('; ')}`);
    },
  };
  return c;
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

export function client(s, reviewer = REVIEWER) {
  const api = async (method, url, body) => {
    const res = await fetch(s.api + url, {
      method,
      headers: { 'X-Reviewer': reviewer, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return { api };
}

/** The item's own "✔ Approve" button, not the "approve all" hint that can appear beside it. */
export const APPROVE = /^\W*Approve\s*$/;

export const pending = v => v.items.filter(i => !i.decision);
export const isText = i => (i.finding.kind ?? 'Text') === 'Text';

export const reviewerInit = [name => localStorage.setItem('agenticfoia.reviewer', name), REVIEWER];

export function manifest(s) {
  return JSON.parse(fs.readFileSync(path.join(s.corpus, 'manifest.json'), 'utf8'));
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

// ---- Scenes shared by the tours; cues are fractions of each scene's narration ----------

export const tab = (page, label) => page.locator('nav.tabs button', { hasText: label });
export const approveButton = (page, id) => page.locator(`#item-${id} forge-button`, { hasText: APPROVE });

/** The Records Requests grid and its Mock RMS badge. */
export async function sceneGrid(t) {
  await t.at(0.3);
  await t.moveTo(t.page.locator('.queue-table tbody tr').first(), { dx: 0.4, steps: 40 });
  await t.at(0.75);
  await t.moveTo(t.page.locator('.badge.mock').first(), { steps: 40 });
}

/** Opens the request: its header, then the Referenced Records tab. */
export async function sceneRequest(t, requestNumber, { refs = 0.45, first = 0.6, last = 0.8 } = {}) {
  const page = t.page;
  await t.at(0.04);
  await t.click(page.locator('.queue-table a.cell-link', { hasText: requestNumber }));
  await page.locator('.record-title h1').waitFor();
  await t.at(0.12);
  await t.moveTo(page.locator('header .record-details'), { dx: 0.3, steps: 40 });
  await t.at(0.25);
  await t.moveTo(page.locator('header .record-details > div').nth(3), { steps: 30 });
  await t.at(refs);
  await t.click(tab(page, 'Referenced Records'));
  await t.at(first);
  await t.moveTo(page.locator('table.table tbody tr').first().locator('td').last(), { dx: 0.3, steps: 40 });
  await t.at(last);
  await t.moveTo(page.locator('table.table tbody tr').last().locator('td').last(), { dx: 0.3, steps: 30 });
}

/** Starts a redaction review, imports the referenced records (analysis starts) and opens the review's file list. */
export async function sceneStartReview(t, rc, { importAt = 0.22, open = 0.45, rows = 0.6 } = {}) {
  const page = t.page;
  await t.at(0.03);
  await t.click(tab(page, 'Redaction Review'));
  await t.at(0.1);
  await t.click(page.locator('forge-button', { hasText: 'Start redaction review' }));
  const importButton = page.locator('forge-button', { hasText: 'Import from referenced records' });
  await importButton.waitFor();
  await rc.useReview();
  await t.at(importAt);
  await t.click(importButton);
  await page.locator('.banner', { hasText: 'Imported' }).waitFor({ timeout: 120000 });
  await t.at(open);
  await t.click(page.locator('forge-button', { hasText: 'Open review' }));
  await page.locator('table.table tbody tr').first().waitFor();
  await t.at(rows);
  await t.moveTo(page.locator('table.table tbody tr').last(), { dx: 0.25, steps: 40 });
  await t.at(0.85);
  await t.moveTo(page.locator('table.table tbody tr').first().locator('td').nth(2), { steps: 30 });
}

/**
 * The text report: approve one item, deny one ({ item, note }), add a missed value, then move a rule up to the
 * review. cues: { approve, approveClick, deny, denyClick?, manual, rule, ruleClick, end }.
 */
export async function sceneReview(t, { approve, deny, manual }, cues) {
  const page = t.page;
  await t.at(cues.approve);
  if (approve) {
    await t.click(page.locator(`#item-${approve.id}`));
    await t.at(cues.approveClick);
    await t.click(approveButton(page, approve.id));
  }
  if (deny) {
    await t.at(cues.deny);
    await t.click(page.locator(`#item-${deny.item.id}`));
    await t.typeInto(page.locator(`#item-${deny.item.id} .item-actions input`), deny.note);
    if (cues.denyClick) await t.at(cues.denyClick);
    await t.click(page.locator(`#item-${deny.item.id} forge-button`, { hasText: 'Deny' }));
  }
  if (manual) { await t.at(cues.manual); await addManual(t, manual); }
  // "Move a rule up to the whole review."
  await t.at(cues.rule);
  const fileRules = page.locator('forge-card.instructions').nth(1);
  await fileRules.evaluate(el => { el.querySelector('details').open = true; });
  await fileRules.scrollIntoViewIfNeeded();
  const promote = fileRules.locator('forge-button', { hasText: 'review' }).first();
  if (await promote.count()) {
    await t.moveTo(promote, { steps: 40 });
    await t.at(cues.ruleClick);
    await t.click(promote);
  }
  await t.at(cues.end);
  await page.locator('forge-card.instructions').first().evaluate(el => { el.querySelector('details').open = true; });
}

/** Opens a document in the review page and waits until its video can play. */
export async function openVideo(t, url) {
  await t.page.goto(url);
  await t.page.locator('.media-viewer video').waitFor();
  await t.page.waitForFunction(() => document.querySelector('.media-viewer video')?.readyState >= 1);
}

/** The body-camera video: play, pause, approve a spoken item, then a box drawn over the licence plate (media.json). */
export async function sceneVideo(t, target, media) {
  const page = t.page;
  await t.at(0.03);
  await t.click(page.locator('.player .controls button[title^="Play"]').first());
  await t.at(0.28);
  await t.click(page.locator('.player .controls button[title^="Pause"]').first());
  if (target) {
    await t.click(page.locator(`#item-${target.id}`));
    await sleep(800);
    await t.click(approveButton(page, target.id));
  }
  // "The clerk can draw a box over anything else, such as a license plate."
  await t.at(0.7);
  await t.click(page.locator('.player .controls button', { hasText: 'Draw box' }).first());
  const v = await page.locator('.media-viewer video').boundingBox();
  const k = Math.min(v.width / media.width, v.height / media.height);
  const ox = v.x + (v.width - media.width * k) / 2, oy = v.y + (v.height - media.height * k) / 2;
  const p = media.plate, pad = 8;
  await t.drag({ x: ox + (p.x - pad) * k, y: oy + (p.y - pad) * k }, { x: ox + (p.x + p.w + pad) * k, y: oy + (p.y + p.h + pad) * k });
  const bar = page.locator('.draft-bar');
  await t.typeInto(bar.locator('input[placeholder^=Label]'), 'licence plate');
  const nums = bar.locator('input[type=number]');
  if (await nums.count() === 2) { await nums.nth(0).fill('0'); await nums.nth(1).fill('999'); }
  await t.click(bar.locator('forge-button', { hasText: 'Add redaction' }));
  await t.at(0.88);
  await t.click(page.locator('.player .controls button[title^="Play"]').first());
}

/** Export & mark complete, then the original next to the redacted copy (base: the document's /api path). */
export async function sceneExport(t, s, base, { compare = 0.4 } = {}) {
  const page = t.page;
  await t.at(0.05);
  await t.click(page.locator('forge-button', { hasText: 'Export & mark complete' }));
  await page.locator('.downloads').waitFor({ timeout: 120000 });
  await t.moveTo(page.locator('.downloads forge-button').first(), { steps: 30 });
  await t.at(compare);
  await t.helper(`${s.web}/tour/compare.html?a=${encodeURIComponent(base + '/original')}&b=${encodeURIComponent(base + '/export/file')}`);
}

/** Packet sign-off on the request, what was written back (Documents, General, Event Log), then the combined log. */
export async function scenePacket(t, s, rc, { approve = 0.16, docs = 0.32, general = 0.46, events = 0.6, log = 0.78, scroll } = {}) {
  const page = t.page;
  await t.at(0.04);
  await t.moveTo(page.locator('.packet'), { dx: 0.3, steps: 35 });
  await t.typeInto(page.locator('.packet input[name=note]'), 'Released except approved redactions.');
  await t.at(approve);
  await t.click(page.locator('.packet forge-button', { hasText: 'Approve packet' }));
  await page.locator('.packet', { hasText: 'Approved by' }).waitFor({ timeout: 120000 });
  await t.at(docs);
  await t.click(tab(page, 'Documents'));
  await t.moveTo(page.locator('table.table tbody tr').first(), { dx: 0.2, steps: 30 });
  await t.at(general);
  await t.click(tab(page, 'General'));
  await t.moveTo(page.locator('.record-details.general > div').nth(4), { steps: 30 });
  await t.at(events);
  await t.click(tab(page, 'Event Log'));
  await t.moveTo(page.locator('table.table tbody tr').first(), { dx: 0.4, steps: 30 });
  await t.at(log);
  await t.helper(`${s.web}/tour/log.html?url=${encodeURIComponent(`/api${rc.R()}/packet/log`)}&name=${encodeURIComponent('Combined redaction log')}`, 30000);
  if (scroll) {
    await page.mouse.move(960, 600, { steps: 30 });
    await t.at(scroll);
    await page.mouse.wheel(0, 400);
  }
}

/** The records-system seam diagram (pages/rms.html), stepped with the narration. */
export async function sceneSeam(t) {
  const step = n => t.page.evaluate(k => window.step(k), n);
  await step(1);
  await t.at(0.12); await step(2);
  await t.at(0.3); await step(3);
  await t.at(0.7); await step(4);
}
