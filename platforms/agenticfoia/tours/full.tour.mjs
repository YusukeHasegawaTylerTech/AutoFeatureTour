// AgenticFOIA complete walkthrough (scripts/full.md): the record-request tour (rms) plus a denial with a note, photo
// OCR, and a scanned PDF with ID photos (OCR, a detected face, a photo boxed by hand), compared before and after.
//
// The scan (014-witness-statement-scanned.pdf + form-truth.json) is made with make-scan.cs --form <photo> when
// --face-photo <image with two portraits> is given (read where it is, never copied into a repo); otherwise --scan-file
// and --form-truth, or the newest pair found in a previous pdf-ocr run's folder (out/agenticfoia-pdf-ocr/...), are
// used. Detection models (--detection-models / AGENTICFOIA_Media__DetectionModels) and the speech models are needed.
//
//   aft run platforms/agenticfoia/tours/full.tour.mjs --face-photo <portraits.png> [--engine Placeholder] [--skip-build]

import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../../src/util.mjs';
import {
  SCAN_NAME, approveButton, build, findTesseract, freshData, isText, launch, loadScanTruth, makeMedia, makeScan, manifest,
  openVideo, pending, placeRecords, pronounce, recordFileCount, requireDetection, requireSpeechModels, reviewClient, reviewerInit, rmsRecords, sceneExport, sceneGrid,
  scenePacket, sceneRequest, sceneReview, sceneSeam, sceneStartReview, sceneVideo, seedRequests, settings,
} from '../app.mjs';

const REVIEW_FILE = '008-incident-report.txt';
const EXPORT_FILE = '006-incident-report.pdf';
const IMAGE_FILE = 'evidence-note.png';
/** The scanned PDF and its page-2 ground truth: made now with --face-photo, given, or from an earlier pdf-ocr run. */
async function scan(ctx, s) {
  const o = ctx.options;
  if (o.facePhoto) return makeScan(ctx, s, o.facePhoto);
  if (o.scanFile || o.formTruth) {
    const pair = { scanFile: path.resolve(o.scanFile ?? ''), formTruth: path.resolve(o.formTruth ?? '') };
    if (!o.scanFile || !o.formTruth || !fs.existsSync(pair.scanFile) || !fs.existsSync(pair.formTruth))
      throw new Error('--scan-file and --form-truth must both point to existing files');
    return pair;
  }
  // A previous pdf-ocr run's folder (or the folder itself), newest first.
  const base = path.join(path.resolve(process.env.AFT_OUT_DIR ?? path.join(ctx.toolRoot, 'out')), 'agenticfoia-pdf-ocr');
  const dirs = fs.existsSync(base)
    ? [base, ...fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(base, d.name))]
    : [];
  const found = dirs.map(d => ({ scanFile: path.join(d, SCAN_NAME), formTruth: path.join(d, 'form-truth.json') }))
    .filter(p => fs.existsSync(p.scanFile) && fs.existsSync(p.formTruth))
    .sort((a, b) => fs.statSync(b.scanFile).mtimeMs - fs.statSync(a.scanFile).mtimeMs)[0];
  if (!found) throw new Error(`No scanned PDF: pass --face-photo <image with two portraits> (or --scan-file and --form-truth); none with form-truth.json was found under ${base}`);
  ctx.log(`reusing the scan from ${path.dirname(found.scanFile)}`);
  return found;
}

/** A denial for the text report: a "keep" value if proposed, else a suggestion not in the ground truth, else any one
 *  other than the approval (approved again off camera before export). */
function pickDenial(items, truth, approve) {
  const keep = (truth?.keep ?? []).map(k => k.text ?? k);
  const redact = (truth?.redact ?? []).map(r => r.text);
  const others = items.filter(i => i !== approve);
  const k = others.find(i => keep.some(x => i.finding.originalText.includes(x) || x.includes(i.finding.originalText)));
  if (k) return { item: k, note: 'Officer name, public record', redo: false };
  const extra = others.find(i => !redact.some(x => i.finding.originalText.includes(x) || x.includes(i.finding.originalText)));
  if (extra) return { item: extra, note: 'Not exempt: public information', redo: false };
  return others.length ? { item: others.at(-1), note: 'Check with supervisor', redo: true } : null;
}

export default {
  platform: 'agenticfoia',
  name: 'agenticfoia-full',
  script: '../scripts/full.md',
  pronounce,
  async record(ctx) {
    const s = await settings(ctx);
    requireSpeechModels(s);
    findTesseract(s);
    requireDetection(s);
    const { scanFile, formTruth } = await scan(ctx, s);
    const scanName = path.basename(scanFile);
    const bins = await build(ctx, s);
    const dataRoot = freshData(ctx, s);
    const media = await makeMedia(ctx);
    const records = rmsRecords({ caseExtra: [scanFile] });
    placeRecords(dataRoot, records, { corpus: s.corpus, mediaDir: media.dir });
    const corpusTruth = manifest(s);
    const truthOf = name => corpusTruth.files.find(f => f.file === name);
    const scanTruth = loadScanTruth(s, formTruth);

    const stop = await launch(ctx, s, { ...bins, dataRoot });
    try {
      const { requestId, requestNumber } = await seedRequests(s, records);
      ctx.log(`record request ${requestNumber}`);
      const rc = reviewClient(s, requestId);
      const t = ctx.tour;
      const page = await t.start({ initScripts: [reviewerInit] });
      await page.goto(s.web);
      await page.locator('.queue-table tbody tr').first().waitFor();

      // 1–3. The grid, the request and its referenced records, then a review started and the records imported.
      await t.scene('scene-01', () => sceneGrid(t));
      await t.scene('scene-02', () => sceneRequest(t, requestNumber, { refs: 0.42, first: 0.55, last: 0.8 }));
      await t.scene('scene-03', () => sceneStartReview(t, rc, { importAt: 0.2, open: 0.42, rows: 0.58 }));

      ctx.log('waiting for analysis…');
      await rc.waitForAnalysis(recordFileCount(records), 40 * 60000);

      // 4. The typed report: approve an SSN, deny one suggestion with a note, add a missed value by hand.
      const textDoc = await rc.docId(REVIEW_FILE);
      const v = await rc.view(textDoc);
      const truth = truthOf(REVIEW_FILE);
      const items = pending(v).filter(isText);
      const approve = items.find(i => /ssn|social/i.test(i.finding.category)) ?? items[0];
      const deny = pickDenial(items, truth, approve);
      const covered = x => v.items.some(i => i.finding.originalText.includes(x) || x.includes(i.finding.originalText));
      const missed = (truth?.redact ?? []).find(r => !covered(r.text) && v.segments.some(g => g.text.includes(r.text)));
      const manual = missed ? { text: missed.text, category: missed.category } : null;
      ctx.log(`review: approve ${approve?.id ?? '-'}, deny ${deny ? `${deny.item.id} "${deny.item.finding.originalText}"` : '-'}, add ${manual ? `"${manual.text}"` : '-'}`);
      await page.goto(rc.docPage(textDoc));
      await page.locator('ol.items li.item').first().waitFor();
      await t.scene('scene-04', () => sceneReview(t, { approve, deny, manual },
        { approve: 0.1, approveClick: 0.2, deny: 0.26, denyClick: 0.33, manual: 0.47, rule: 0.8, ruleClick: 0.88, end: 0.95 }));
      if (deny?.redo) await rc.api('POST', `${rc.R()}/documents/${textDoc}/decisions`, [{ findingId: deny.item.id, decision: 'Approved', note: 'Supervisor: redact' }]);

      // 5. The evidence photo: the OCR'd words on the image; selecting a suggestion highlights its box, then it is approved.
      const imageDoc = await rc.docId(IMAGE_FILE);
      const iv = await rc.view(imageDoc);
      await page.goto(rc.docPage(imageDoc));
      await page.locator('.media-viewer img').waitFor();
      await page.waitForFunction(() => document.querySelector('.media-viewer img')?.complete);
      await t.scene('scene-05', async () => {
        await t.at(0.08);
        await t.moveTo(page.locator('.media-viewer div.screen'), { dx: 0.4, dy: 0.4, steps: 40 });
        for (const [n, item] of pending(iv).filter(isText).slice(0, 2).entries()) {
          await t.at([0.4, 0.62][n]);
          await t.click(page.locator(`#item-${item.id}`));
          await sleep(900);
          await t.click(approveButton(page, item.id));
        }
        await t.at(0.85);
        await t.moveTo(page.locator('.media-viewer div.screen'), { dx: 0.6, dy: 0.5, steps: 40 });
      });

      // 6. The scanned statement: text suggestions, the detected face, and the photo the detector missed boxed by hand.
      const scanDoc = await rc.docId(scanName);
      const sv = await rc.view(scanDoc);
      const detected = pending(sv).find(i => i.finding.kind === 'Region' && i.finding.media?.detectionId);
      const found = (sv.detections ?? []).flatMap(d => d.boxes);
      const inside = (b, p) => b.t === p.t && b.x + b.w / 2 >= p.x && b.x + b.w / 2 <= p.x + p.w && b.y + b.h / 2 >= p.y && b.y + b.h / 2 <= p.y + p.h;
      const missedPhoto = scanTruth.photos.map(p => p.box).find(p => !found.some(b => inside(b, p)));
      ctx.log(`scan: ${pending(sv).length} pending; face ${detected?.id ?? '-'}; missed photo ${missedPhoto ? JSON.stringify(missedPhoto) : '-'}`);
      // Page-pixel point → viewport point inside a page image of the Page images card.
      const pagePoint = async (n, x, y) => {
        const frame = page.locator(`.pdf-page[data-page="${n}"] .pdf-page-frame`);
        await frame.scrollIntoViewIfNeeded();
        const b = await frame.boundingBox();
        return { x: b.x + x * b.width / sv.layout.width, y: b.y + y * b.height / sv.layout.height };
      };
      await page.goto(rc.docPage(scanDoc));
      await page.locator('ol.items li.item').first().waitFor();
      await page.locator('.pdf-pages .pdf-page').first().waitFor({ timeout: 60000 });
      await t.scene('scene-06', async () => {
        await t.at(0.06);
        await t.moveTo(page.locator('section.doc pre.text').first(), { dx: 0.3, dy: 0.2, steps: 40 });
        for (const [n, item] of pending(sv).filter(isText).slice(0, 2).entries()) {
          await t.at([0.22, 0.32][n]);
          await t.click(page.locator(`#item-${item.id}`));
          await t.click(approveButton(page, item.id));
        }
        await t.at(0.44);
        const card = page.locator('.pdf-pages');
        await card.scrollIntoViewIfNeeded();
        await page.evaluate(() => scrollBy(0, -80));
        if (detected) {
          const b = detected.finding.media.boxes[0];
          const p = await pagePoint(Math.round(b.t), b.x + b.w / 2, b.y + b.h / 2);
          await t.at(0.5);
          await page.mouse.move(p.x, p.y, { steps: 35 });
          await t.at(0.6);
          await t.click(page.locator(`#item-${detected.id}`));
          await t.click(approveButton(page, detected.id));
          await card.scrollIntoViewIfNeeded();
        }
        if (missedPhoto) {
          const m = missedPhoto, pad = 10;
          await t.at(0.7);
          const a = await pagePoint(m.t, m.x - pad, m.y - pad);
          await page.mouse.move(a.x - 30, a.y - 30, { steps: 25 });
          await page.mouse.move(a.x, a.y, { steps: 15 });
          await t.at(0.76);
          const z = await pagePoint(m.t, m.x + m.w + pad, m.y + m.h + pad);
          await page.mouse.down();
          await page.mouse.move(z.x, z.y, { steps: 30 });
          await page.mouse.up();
          await t.typeInto(page.locator('.pdf-pages .draft-bar input'), 'Face (subject photo)');
          await t.at(0.86);
          await t.click(page.locator('.pdf-pages .draft-bar forge-button', { hasText: 'Add redaction' }));
        }
      });

      // 7. The body-camera video.
      const videoDoc = await rc.docId(media.info.video);
      const vv = await rc.view(videoDoc);
      const spoken = pending(vv).find(i => isText(i) && /name/i.test(i.finding.category)) ?? pending(vv)[0];
      await openVideo(t, rc.docPage(videoDoc));
      await t.scene('scene-07', () => sceneVideo(t, spoken, media.info));

      // 8. Export the typed PDF report (missed values added and the rest approved off camera) and compare it.
      const pdfDoc = await rc.docId(EXPORT_FILE);
      await rc.addMissed(pdfDoc, truthOf(EXPORT_FILE)?.redact ?? []);
      await rc.approveRest(pdfDoc);
      await page.goto(`${rc.docPage(pdfDoc)}/export`);
      await page.locator('forge-button', { hasText: 'Export & mark complete' }).waitFor();
      await t.scene('scene-08', () => sceneExport(t, s, rc.docApi(pdfDoc), { compare: 0.35 }));

      // Off camera: finish every other file (values the engine missed added by hand, the rest approved) and export it.
      await rc.finishAndExport(pdfDoc, { redactFor: name => (name === scanName ? scanTruth : truthOf(name))?.redact, log: ctx.log });

      // 9. The scan (both pages) and the photo, original next to the redacted export.
      const sb = rc.docApi(scanDoc);
      await t.helper(`${s.web}/tour/compare.html?a=${encodeURIComponent(sb + '/original')}&b=${encodeURIComponent(sb + '/export/file')}`);
      await t.scene('scene-09', async () => {
        const b = await page.locator('#b').boundingBox();
        await t.at(0.1);
        await page.mouse.move(b.x + b.width * 0.35, b.y + Math.min(b.height * 0.2, 260), { steps: 40 });
        await t.at(0.4);
        await page.evaluate(() => window.showPage(2));
        await t.at(0.5);
        await page.mouse.move(b.x + b.width * 0.82, b.y + Math.min(b.height * 0.33, 600), { steps: 40 });
        await t.at(0.62);
        await page.mouse.move(b.x + b.width * 0.55, b.y + Math.min(b.height * 0.29, 520), { steps: 40 });
        await t.at(0.8);
        const ib = rc.docApi(imageDoc);
        await t.helper(`${s.web}/tour/compare.html?kind=image&a=${encodeURIComponent(ib + '/original')}&b=${encodeURIComponent(ib + '/export/file')}`);
        await page.mouse.move(960, 400, { steps: 30 });
      });

      // 10. Sign off the packet on the record request and show what was written back to it.
      await page.goto(rc.requestPage('?tab=review'));
      await page.locator('.packet forge-button', { hasText: 'Approve packet' }).waitFor();
      await t.scene('scene-10', () => scenePacket(t, s, rc, { approve: 0.15, docs: 0.3, general: 0.44, events: 0.58, log: 0.76, scroll: 0.86 }));

      // 11. How the records-system seam slots into RMS.
      await t.helper(`${s.web}/tour/rms.html`);
      await t.scene('scene-11', () => sceneSeam(t));

      await t.finish({ requestId, reviewId: rc.reviewId });
    } finally {
      stop();
    }
  },
};
