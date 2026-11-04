// AgenticFOIA scanned-PDF tour (scripts/pdf-ocr.md): OCR of an image-only PDF, review, the export pipeline, the
// re-OCR leak check and the log. The scan is made by make-scan.cs from a synthetic test-corpus PDF.
//
//   node src/cli.mjs targets/agenticfoia/pdf-ocr.tour.mjs --record [--engine Placeholder] [--skip-build]

import path from 'node:path';
import { sleep } from '../../src/util.mjs';
import {
  APPROVE, addManual, build, client, createProjectAndUpload, denyItem, findTesseract, freshData, launch, manifest, pending,
  pickReview, pronounce, reviewerInit, settings,
} from './app.mjs';

const PROJECT = 'Records request R-26-0152 (scanned statement)';
const SOURCE_FILE = '014-witness-statement.pdf';
const PDF_DPI = 200;

export default {
  name: 'agenticfoia-pdf-ocr',
  script: 'scripts/pdf-ocr.md',
  pronounce,
  async record(ctx) {
    const s = await settings(ctx);
    findTesseract(s); // the scanned-PDF tour needs only Tesseract
    s.media = { Tesseract: s.media.Tesseract };
    const bins = await build(ctx, s);
    const dataRoot = freshData(ctx, s);
    // A synthetic scan of a corpus PDF (rendered, tilted, image only), so its ground truth is in manifest.json.
    const scanFile = path.join(ctx.outDir, SOURCE_FILE.replace('.pdf', '-scanned.pdf'));
    await ctx.run('dotnet', ['run', path.join(ctx.targetDir, 'make-scan.cs'), '--', path.join(s.corpus, SOURCE_FILE), scanFile]);
    const scanName = path.basename(scanFile);
    const truth = manifest(s).files.find(f => f.file === SOURCE_FILE) ?? { redact: [], keep: [] };
    const c = client(s);

    const stop = await launch(ctx, s, { ...bins, dataRoot, routes: [{ path: '/tour/scan.pdf', file: scanFile }] });
    try {
      const t = ctx.tour;
      const page = await t.start({ initScripts: [reviewerInit] });

      // 1. The scan: no text layer, so a search finds nothing.
      await t.helper(`${s.web}/tour/scan.html?pdf=/tour/scan.pdf&name=${encodeURIComponent(scanName)}`);
      await t.scene('scene-01', async () => {
        await t.at(0.15);
        await t.moveTo(page.locator('#page'), { dx: 0.4, dy: 0.3, steps: 40 });
        await t.at(0.4);
        await t.moveTo(page.locator('#chars'), { steps: 35 });
        await t.at(0.62);
        const name = truth.redact.find(r => /Witness|Name/.test(r.category))?.text.split(' ').pop() ?? 'Faulkner';
        await t.typeInto(page.locator('#q'), name);
        await t.at(0.85);
        await t.moveTo(page.locator('#result'), { dx: 0.1, steps: 30 });
      });

      await page.goto(s.web);
      await page.locator('.queue-head').waitFor();
      let projectId;
      await t.scene('scene-02', async () => {
        await t.at(0.05);
        projectId = await createProjectAndUpload(t, PROJECT, [scanFile], { uploadAt: 0.4, pointAt: 0.75 });
      });

      ctx.log('waiting for OCR and analysis…');
      const documentId = (await c.waitForAnalysis(projectId, 1, 15 * 60000))[0].metadata.documentId;
      const v = await c.view(projectId, documentId);
      ctx.log(`OCR text: ${v.segments.map(x => x.text.length).join('+')} chars; ${v.items.length} suggestion(s)`);

      // 3. The OCR warning and recognized text, then the stored word map with one word's entry (the phone if read).
      const text = v.segments.map(x => x.text).join('\n');
      const focus = truth.redact.find(r => r.category === 'Phone' && text.includes(r.text))?.text.split(' ').pop()
        ?? truth.redact.find(r => text.includes(r.text))?.text.split(' ')[0] ?? text.split(/\s+/)[0];
      await page.goto(`${s.web}/projects/${projectId}/documents/${documentId}`);
      await page.locator('ol.items li.item, section.doc pre.text').first().waitFor();
      await t.scene('scene-03', async () => {
        await t.at(0.04);
        await t.moveTo(page.locator('.banner.warn').first(), { dx: 0.3, steps: 30 });
        await t.at(0.16);
        await t.moveTo(page.locator('section.doc pre.text').first(), { dx: 0.3, dy: 0.2, steps: 35 });
        await t.at(0.3);
        await t.helper(`${s.web}/tour/ocr.html?doc=${encodeURIComponent(`/api/projects/${projectId}/documents/${documentId}`)}&pdf=/tour/scan.pdf&dpi=${PDF_DPI}`);
        await page.evaluate(ms => window.reveal(ms), Math.round(t.current.seconds * 0.25 * 1000));
        await t.at(0.66);
        await page.evaluate(w => window.focusWord(w), focus);
        await t.moveTo(page.locator('#entry'), { dx: 0.3, steps: 35 });
      });

      // 4. Approve a few suggestions, deny an officer name if proposed, add a value the engine missed.
      const { items, deny, manual } = pickReview(v, truth);
      const approve = items.filter(i => i !== deny).slice(0, 3);
      ctx.log(`review: approve ${approve.map(i => i.id).join(',') || '-'}, deny ${deny?.id ?? '-'}, add ${manual ? `"${manual.text}"` : '-'}`);
      await page.goto(`${s.web}/projects/${projectId}/documents/${documentId}`);
      await page.locator('ol.items li.item').first().waitFor();
      await t.scene('scene-04', async () => {
        await t.at(0.1);
        for (const [i, item] of approve.entries()) {
          await t.at(0.42 + i * 0.1);
          await t.click(page.locator(`#item-${item.id}`));
          await t.click(page.locator(`#item-${item.id} forge-button`, { hasText: APPROVE }));
        }
        if (deny) { await t.at(0.68); await denyItem(t, deny); }
        if (manual) { await t.at(0.8); await addManual(t, manual); }
      });

      // Off camera, the clerk finishes the review: every remaining occurrence of a ground-truth value the engine
      // missed is added by hand, and the rest of the suggestions are approved.
      const done = await c.view(projectId, documentId);
      const covers = (seg, a, b) => done.items.some(i => i.finding.segmentId === seg && i.decision?.decision !== 'Denied' &&
        i.finding.start <= a && i.finding.start + i.finding.length >= b);
      for (const r of truth.redact)
        for (const seg of done.segments)
          for (let at = seg.text.indexOf(r.text); at >= 0; at = seg.text.indexOf(r.text, at + r.text.length))
            if (!covers(seg.id, at, at + r.text.length))
              await c.api('POST', `/projects/${projectId}/documents/${documentId}/redactions`,
                { segmentId: seg.id, start: at, length: r.text.length, category: r.category, reason: 'Missed by the engine' });
      if (pending(await c.view(projectId, documentId)).length) await c.approveRest(projectId, documentId);

      // 5. The export pipeline diagram, stepped in time with the narration.
      await t.helper(`${s.web}/tour/pipeline.html`);
      await t.scene('scene-05', async () => {
        for (let n = 1; n <= 5; n++) { await page.evaluate(k => window.step(k), n); await sleep(350); }
        for (const [n, f] of [[6, 0.12], [7, 0.32], [8, 0.47], [9, 0.64], [10, 0.82]]) {
          await t.at(f);
          await page.evaluate(k => window.step(k), n);
        }
      });

      // 6. Export (includes the re-OCR leak check) and compare with the original.
      await page.goto(`${s.web}/projects/${projectId}/documents/${documentId}/export`);
      await page.locator('forge-button', { hasText: 'Export & mark complete' }).waitFor();
      await t.scene('scene-06', async () => {
        await t.at(0.03);
        await t.click(page.locator('forge-button', { hasText: 'Export & mark complete' }));
        await page.locator('.downloads').waitFor({ timeout: 180000 });
        await t.moveTo(page.locator('.downloads forge-button').first(), { steps: 30 });
        await t.at(0.22);
        const base = `/api/projects/${projectId}/documents/${documentId}`;
        await t.helper(`${s.web}/tour/compare.html?a=${encodeURIComponent(base + '/original')}&b=${encodeURIComponent(base + '/export/file')}`);
        await t.at(0.45);
        const b = await page.locator('#b').boundingBox(); // point at the redacted lines without scrolling the page
        await page.mouse.move(b.x + b.width * 0.35, b.y + Math.min(b.height * 0.2, 260), { steps: 40 });
      });

      // 7. The redaction log.
      await t.helper(`${s.web}/tour/log.html?url=${encodeURIComponent(`/api/projects/${projectId}/documents/${documentId}/export/log`)}&name=${encodeURIComponent(scanName)}`);
      await t.scene('scene-07', async () => {
        await t.at(0.25);
        await page.mouse.move(960, 500, { steps: 30 });
        await page.mouse.wheel(0, 300);
        await t.at(0.65);
        await page.mouse.wheel(0, -300);
      });

      await t.finish({ projectId });
    } finally {
      stop();
    }
  },
};
