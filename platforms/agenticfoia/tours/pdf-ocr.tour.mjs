// AgenticFOIA scanned-PDF tour (scripts/pdf-ocr.md): OCR of a two-page image-only scan (a witness statement, and a
// form with tables and two ID photos), imported from a Mock RMS record request; review, faces (a detected one approved,
// a missed one boxed by hand), the export pipeline, the re-OCR leak check and the log. The scan and its ground truth
// (form-truth.json, next to it in the run folder, which the full tour can reuse) are made by make-scan.cs --form.
//
//   aft run platforms/agenticfoia/tours/pdf-ocr.tour.mjs --face-photo <image with two portraits> [--engine Placeholder] [--skip-build]

import { sleep } from '../../../src/util.mjs';
import {
  APPROVE, SCAN_NAME, addManual, build, findTesseract, freshData, isText, launch, loadScanTruth, makeScan, pending,
  placeRecords, pronounce, requireDetection, reviewClient, reviewerInit, sceneStartReview, seedRequests, settings,
} from '../app.mjs';

const PDF_DPI = 200;
const RECORDS = [{ type: 'Case', number: 'C26-002061', address: null, subject: 'Witness statement (scanned)', otherFiles: [] }];

export default {
  platform: 'agenticfoia',
  name: 'agenticfoia-pdf-ocr',
  script: '../scripts/pdf-ocr.md',
  pronounce,
  async record(ctx) {
    const s = await settings(ctx);
    findTesseract(s); // the scanned-PDF tour needs Tesseract and the detection models, not the speech models
    requireDetection(s);
    s.media = { Tesseract: s.media.Tesseract, DetectionModels: s.media.DetectionModels };
    const { scanFile, formTruth } = await makeScan(ctx, s, ctx.options.facePhoto);
    const truth = loadScanTruth(s, formTruth);
    const bins = await build(ctx, s);
    const dataRoot = freshData(ctx, s);
    const records = RECORDS.map(r => ({ ...r, otherFiles: [scanFile] }));
    placeRecords(dataRoot, records, { corpus: s.corpus, mediaDir: ctx.outDir });

    const stop = await launch(ctx, s, { ...bins, dataRoot, routes: [{ path: '/tour/scan.pdf', file: scanFile }] });
    try {
      const { requestId, requestNumber } = await seedRequests(s, records, { details: 'The scanned witness statement and persons form for' });
      ctx.log(`record request ${requestNumber}`);
      const rc = reviewClient(s, requestId);
      const t = ctx.tour;
      const page = await t.start({ initScripts: [reviewerInit] });

      // 1. The scan: no text layer, so a search finds nothing.
      await t.helper(`${s.web}/tour/scan.html?pdf=/tour/scan.pdf&name=${encodeURIComponent(SCAN_NAME)}`);
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

      // 2. The request (opened off camera): start a review and import the scan from the referenced case record.
      await page.goto(rc.requestPage());
      await page.locator('.record-title h1').waitFor();
      await t.scene('scene-02', () => sceneStartReview(t, rc, { importAt: 0.25, open: 0.5, rows: 0.7 }));

      ctx.log('waiting for OCR and analysis…');
      const documentId = (await rc.waitForAnalysis(1, 15 * 60000))[0].metadata.documentId;
      const v = await rc.view(documentId);
      ctx.log(`OCR text: ${v.segments.map(x => x.text.length).join('+')} chars; ${v.items.length} suggestion(s)`);

      // 3. The OCR warning and recognized text, then the stored word map with one word's entry (the phone if read).
      const text = v.segments.map(x => x.text).join('\n');
      const focus = truth.redact.find(r => r.category === 'Phone' && text.includes(r.text))?.text.split(' ').pop()
        ?? truth.redact.find(r => text.includes(r.text))?.text.split(' ')[0] ?? text.split(/\s+/)[0];
      await page.goto(rc.docPage(documentId));
      await page.locator('ol.items li.item, section.doc pre.text').first().waitFor();
      await t.scene('scene-03', async () => {
        await t.at(0.04);
        await t.moveTo(page.locator('.banner.warn').first(), { dx: 0.3, steps: 30 });
        await t.at(0.16);
        await t.moveTo(page.locator('section.doc pre.text').first(), { dx: 0.3, dy: 0.2, steps: 35 });
        await t.at(0.3);
        await t.helper(`${s.web}/tour/ocr.html?doc=${encodeURIComponent(rc.docApi(documentId))}&pdf=/tour/scan.pdf&dpi=${PDF_DPI}`);
        await page.evaluate(ms => window.reveal(ms), Math.round(t.current.seconds * 0.25 * 1000));
        await t.at(0.66);
        await page.evaluate(w => window.focusWord(w), focus);
        await t.moveTo(page.locator('#entry'), { dx: 0.3, steps: 35 });
      });

      // 4. Approve a few suggestions, deny an officer name if proposed, add a value the engine missed.
      const keep = truth.keep.map(k => k.text ?? k);
      const items = pending(v).filter(isText);
      const deny = items.find(i => keep.some(k => i.finding.originalText.includes(k) || k.includes(i.finding.originalText)));
      const approve = items.filter(i => i !== deny).slice(0, 3);
      const covered = x => v.items.some(i => i.finding.originalText.includes(x) || x.includes(i.finding.originalText));
      const missed = truth.redact.find(r => !covered(r.text) && v.segments.some(g => g.text.includes(r.text)));
      const manual = missed ? { text: missed.text, category: missed.category } : null;
      ctx.log(`review: approve ${approve.map(i => i.id).join(',') || '-'}, deny ${deny?.id ?? '-'}, add ${manual ? `"${manual.text}"` : '-'}`);
      await page.goto(rc.docPage(documentId));
      await page.locator('ol.items li.item').first().waitFor();
      await t.scene('scene-04', async () => {
        await t.at(0.1);
        for (const [i, item] of approve.entries()) {
          await t.at(0.42 + i * 0.1);
          await t.click(page.locator(`#item-${item.id}`));
          await t.click(page.locator(`#item-${item.id} forge-button`, { hasText: APPROVE }));
        }
        if (deny) {
          await t.at(0.68);
          await t.click(page.locator(`#item-${deny.id}`));
          await t.typeInto(page.locator(`#item-${deny.id} .item-actions input`), 'Officer name, public record');
          await t.click(page.locator(`#item-${deny.id} forge-button`, { hasText: 'Deny' }));
        }
        if (manual) { await t.at(0.8); await addManual(t, manual); }
      });

      // 5. Faces: the detector's face approved; the photo it missed boxed by hand on the page image.
      const afterReview = await rc.view(documentId);
      const detected = pending(afterReview).find(i => i.finding.kind === 'Region' && i.finding.media?.detectionId);
      const found = (afterReview.detections ?? []).flatMap(d => d.boxes);
      const inside = (b, p) => b.t === p.t && b.x + b.w / 2 >= p.x && b.x + b.w / 2 <= p.x + p.w && b.y + b.h / 2 >= p.y && b.y + b.h / 2 <= p.y + p.h;
      const missedPhoto = truth.photos.map(p => p.box).find(p => !found.some(b => inside(b, p)));
      ctx.log(`faces: detected ${(afterReview.detections ?? []).length} (${detected?.id ?? '-'}); missed photo ${missedPhoto ? JSON.stringify(missedPhoto) : '-'}`);
      const pagePoint = async (n, x, y) => {
        const frame = page.locator(`.pdf-page[data-page="${n}"] .pdf-page-frame`);
        await frame.scrollIntoViewIfNeeded();
        const b = await frame.boundingBox();
        return { x: b.x + x * b.width / afterReview.layout.width, y: b.y + y * b.height / afterReview.layout.height };
      };
      await page.locator('.pdf-pages .pdf-page').first().waitFor({ timeout: 60000 });
      await t.scene('scene-05', async () => {
        await t.at(0.04);
        const card = page.locator('.pdf-pages');
        await card.scrollIntoViewIfNeeded();
        await page.evaluate(() => scrollBy(0, -80));
        if (detected) {
          const b = detected.finding.media.boxes[0];
          const p = await pagePoint(Math.round(b.t), b.x + b.w / 2, b.y + b.h / 2);
          await t.at(0.14);
          await page.mouse.move(p.x, p.y, { steps: 35 });
          await t.at(0.3);
          await t.click(page.locator(`#item-${detected.id}`));
          await t.click(page.locator(`#item-${detected.id} forge-button`, { hasText: APPROVE }));
          await card.scrollIntoViewIfNeeded();
        }
        if (missedPhoto) {
          const m = missedPhoto, pad = 10;
          await t.at(0.5);
          const a = await pagePoint(m.t, m.x - pad, m.y - pad);
          await page.mouse.move(a.x - 30, a.y - 30, { steps: 25 });
          await page.mouse.move(a.x, a.y, { steps: 15 });
          await t.at(0.6);
          const z = await pagePoint(m.t, m.x + m.w + pad, m.y + m.h + pad);
          await page.mouse.down();
          await page.mouse.move(z.x, z.y, { steps: 30 });
          await page.mouse.up();
          await t.typeInto(page.locator('.pdf-pages .draft-bar input'), 'Face (subject photo)');
          await t.at(0.74);
          await t.click(page.locator('.pdf-pages .draft-bar forge-button', { hasText: 'Add redaction' }));
        }
      });

      // Off camera, the clerk finishes the review: every remaining occurrence of a ground-truth value the engine
      // missed (repeats of the name, other people's names, table cells) is added by hand, and the rest approved.
      await rc.addMissed(documentId, truth.redact);
      await rc.approveRest(documentId);

      // 6. The export pipeline diagram, stepped in time with the narration (steps 1–5 flash by as a recap).
      await t.helper(`${s.web}/tour/pipeline.html`);
      await t.scene('scene-06', async () => {
        for (let n = 1; n <= 5; n++) { await page.evaluate(k => window.step(k), n); await sleep(350); }
        for (const [n, f] of [[6, 0.12], [7, 0.32], [8, 0.47], [9, 0.64], [10, 0.82]]) {
          await t.at(f);
          await page.evaluate(k => window.step(k), n);
        }
      });

      // 7. Export (includes the re-OCR leak check), then the original and the redacted pages, page 1 and page 2.
      await page.goto(`${rc.docPage(documentId)}/export`);
      await page.locator('forge-button', { hasText: 'Export & mark complete' }).waitFor();
      await t.scene('scene-07', async () => {
        await t.at(0.03);
        await t.click(page.locator('forge-button', { hasText: 'Export & mark complete' }));
        await page.locator('.downloads').waitFor({ timeout: 180000 });
        await t.moveTo(page.locator('.downloads forge-button').first(), { steps: 30 });
        await t.at(0.16);
        const base = rc.docApi(documentId);
        await t.helper(`${s.web}/tour/compare.html?a=${encodeURIComponent(base + '/original')}&b=${encodeURIComponent(base + '/export/file')}`);
        const b = await page.locator('#b').boundingBox(); // point at the redacted lines without scrolling the page
        await t.at(0.3);
        await page.mouse.move(b.x + b.width * 0.35, b.y + Math.min(b.height * 0.2, 260), { steps: 40 });
        await t.at(0.5);
        await page.evaluate(() => window.showPage(2));
        await t.at(0.62);
        await page.mouse.move(b.x + b.width * 0.82, b.y + Math.min(b.height * 0.33, 600), { steps: 40 });
        await t.at(0.8);
        await page.mouse.move(b.x + b.width * 0.55, b.y + Math.min(b.height * 0.29, 520), { steps: 40 });
      });

      // 8. The redaction log.
      await t.helper(`${s.web}/tour/log.html?url=${encodeURIComponent(`${rc.docApi(documentId)}/export/log`)}&name=${encodeURIComponent(SCAN_NAME)}`);
      await t.scene('scene-08', async () => {
        await t.at(0.25);
        await page.mouse.move(960, 500, { steps: 30 });
        await page.mouse.wheel(0, 300);
        await t.at(0.65);
        await page.mouse.wheel(0, -300);
      });

      await t.finish({ requestId, reviewId: rc.reviewId });
    } finally {
      stop();
    }
  },
};
