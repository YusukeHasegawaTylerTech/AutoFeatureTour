// AgenticFOIA main tour (scripts/main.md): upload a request, review a text report, redact a body-camera video,
// export a PDF and show the redaction log. Uploads test-corpus files plus synthetic media from make-media.ps1.
//
//   node src/cli.mjs platforms/agenticfoia/tours/main.tour.mjs --record [--engine Placeholder] [--skip-build]

import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../../src/util.mjs';
import {
  APPROVE, addManual, build, client, createProjectAndUpload, denyItem, findTesseract, freshData, isText, launch, manifest, pending,
  pickReview, pronounce, reviewerInit, settings,
} from '../app.mjs';

const PROJECT = 'Records request R-26-0147';
const CORPUS_FILES = ['008-incident-report.txt', '006-incident-report.pdf', '009-sexual-assault-report.docx', '022-internal-email.eml', '074-cad-call-log.csv'];
const MEDIA_FILES = ['evidence-note.png', '911-call.mp3', 'bodycam-unit12.mp4'];
const REVIEW_FILE = '008-incident-report.txt';
const EXPORT_FILE = '006-incident-report.pdf';

export default {
  platform: 'agenticfoia',
  name: 'agenticfoia-main',
  script: '../scripts/main.md',
  pronounce,
  async record(ctx) {
    const s = await settings(ctx);
    for (const k of ['WhisperModel', 'VadModel'])
      if (!s.media[k] || !fs.existsSync(s.media[k])) throw new Error(`--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).slice(1)} (or AGENTICFOIA_Media__${k}) must point to the model file`);
    findTesseract(s);
    const bins = await build(ctx, s);
    const dataRoot = freshData(ctx, s);
    const mediaDir = path.join(ctx.outDir, 'media');
    await ctx.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.platformDir, 'make-media.ps1'), '-OutDir', mediaDir]);
    const media = JSON.parse(fs.readFileSync(path.join(mediaDir, 'media.json'), 'utf8'));
    const files = [...CORPUS_FILES.map(f => path.join(s.corpus, f)), ...MEDIA_FILES.map(f => path.join(mediaDir, f))];
    const truth = manifest(s).files.find(f => f.file === REVIEW_FILE);
    const c = client(s);

    const stop = await launch(ctx, s, { ...bins, dataRoot });
    try {
      const t = ctx.tour;
      const page = await t.start({ initScripts: [reviewerInit] });
      await page.goto(s.web);
      await page.locator('.queue-head').waitFor();

      // 1. The home page (empty work queue) while the problem is described.
      await t.scene('scene-01', async () => {
        await t.at(0.35);
        await t.moveTo(page.locator('.queue-head h2'), { steps: 40 });
        await t.at(0.7);
        await t.moveTo(page.locator('#add-project'), { steps: 40 });
      });

      let projectId;
      await t.scene('scene-02', async () => {
        await t.at(0.04);
        projectId = await createProjectAndUpload(t, PROJECT, files, { uploadAt: 0.18, pointAt: 0.6 });
      });

      ctx.log('waiting for analysis…');
      await c.waitForAnalysis(projectId, files.length);

      // 3. The text report: approve one item, deny an officer name (a "keep" value) if proposed, add a missed value.
      const textDoc = await c.docId(projectId, REVIEW_FILE);
      const v = await c.view(projectId, textDoc);
      const { items, deny, manual } = pickReview(v, truth);
      const approve = items.find(i => i !== deny && /ssn|social/i.test(i.finding.category)) ?? items.find(i => i !== deny);
      ctx.log(`review: approve ${approve?.id ?? '-'}, deny ${deny?.id ?? '-'}, add ${manual ? `"${manual.text}"` : '-'}`);
      await page.goto(`${s.web}/projects/${projectId}/documents/${textDoc}`);
      await page.locator('ol.items li.item').first().waitFor();
      await t.scene('scene-03', async () => {
        await t.at(0.12);
        if (approve) {
          await t.click(page.locator(`#item-${approve.id}`));
          await t.at(0.3);
          await t.click(page.locator(`#item-${approve.id} forge-button`, { hasText: APPROVE }));
        }
        if (deny) { await t.at(0.36); await denyItem(t, deny); }
        if (manual) { await t.at(0.44); await addManual(t, manual); }
        // "Move a rule up to the whole request."
        await t.at(0.72);
        const fileRules = page.locator('forge-card.instructions').nth(1);
        await fileRules.evaluate(el => { el.querySelector('details').open = true; });
        await fileRules.scrollIntoViewIfNeeded();
        const promote = fileRules.locator('forge-button', { hasText: 'project' }).first();
        if (await promote.count()) {
          await t.moveTo(promote, { steps: 40 });
          await t.at(0.8);
          await t.click(promote);
        }
        await t.at(0.92);
        await page.locator('forge-card.instructions').first().evaluate(el => { el.querySelector('details').open = true; });
      });

      // 4. The body-camera video: play, approve a spoken name, draw a box over the licence plate.
      const videoDoc = await c.docId(projectId, media.video);
      const vv = await c.view(projectId, videoDoc);
      const spoken = pending(vv).find(i => isText(i) && /name/i.test(i.finding.category)) ?? pending(vv)[0];
      await page.goto(`${s.web}/projects/${projectId}/documents/${videoDoc}`);
      await page.locator('.media-viewer video').waitFor();
      await page.waitForFunction(() => document.querySelector('.media-viewer video')?.readyState >= 1);
      await t.scene('scene-04', async () => {
        const play = () => t.click(page.locator('.player .controls button[title^="Play"]').first());
        await t.at(0.03);
        await play();
        await t.at(0.28);
        await t.click(page.locator('.player .controls button[title^="Pause"]').first());
        if (spoken) {
          await t.click(page.locator(`#item-${spoken.id}`));
          await sleep(800);
          await t.click(page.locator(`#item-${spoken.id} forge-button`, { hasText: APPROVE }));
        }
        await t.at(0.7);
        await t.click(page.locator('.player .controls button', { hasText: 'Draw box' }).first());
        const vb = await page.locator('.media-viewer video').boundingBox();
        const k = Math.min(vb.width / media.width, vb.height / media.height);
        const ox = vb.x + (vb.width - media.width * k) / 2, oy = vb.y + (vb.height - media.height * k) / 2;
        const p = media.plate, pad = 8;
        await t.drag({ x: ox + (p.x - pad) * k, y: oy + (p.y - pad) * k }, { x: ox + (p.x + p.w + pad) * k, y: oy + (p.y + p.h + pad) * k });
        const bar = page.locator('.draft-bar');
        await t.typeInto(bar.locator('input[placeholder^=Label]'), 'licence plate');
        const nums = bar.locator('input[type=number]');
        if (await nums.count() === 2) { await nums.nth(0).fill('0'); await nums.nth(1).fill('999'); }
        await t.click(bar.locator('forge-button', { hasText: 'Add redaction' }));
        await t.at(0.88);
        await play();
      });

      // 5. Export the PDF report (the rest approved off camera) and compare it with the original.
      const pdfDoc = await c.docId(projectId, EXPORT_FILE);
      await c.approveRest(projectId, pdfDoc);
      await page.goto(`${s.web}/projects/${projectId}/documents/${pdfDoc}/export`);
      await page.locator('forge-button', { hasText: 'Export & mark complete' }).waitFor();
      await t.scene('scene-05', async () => {
        await t.at(0.05);
        await t.click(page.locator('forge-button', { hasText: 'Export & mark complete' }));
        await page.locator('.downloads').waitFor({ timeout: 120000 });
        await t.moveTo(page.locator('.downloads forge-button').first(), { steps: 30 });
        await t.at(0.4);
        const base = `/api/projects/${projectId}/documents/${pdfDoc}`;
        await t.helper(`${s.web}/tour/compare.html?a=${encodeURIComponent(base + '/original')}&b=${encodeURIComponent(base + '/export/file')}`);
      });

      // 6. The redaction log for that export.
      await t.helper(`${s.web}/tour/log.html?url=${encodeURIComponent(`/api/projects/${projectId}/documents/${pdfDoc}/export/log`)}&name=${encodeURIComponent(EXPORT_FILE)}`, 30000);
      await t.scene('scene-06', async () => {
        await t.at(0.25);
        await page.mouse.move(960, 700, { steps: 30 });
        await page.mouse.wheel(0, 400);
        await t.at(0.6);
        await page.mouse.wheel(0, -400);
      });

      await t.finish({ projectId });
    } finally {
      stop();
    }
  },
};
