// AgenticFOIA main tour (scripts/main.md): start a review from a Mock RMS record request, review a text report,
// redact a body-camera video, export a PDF and show the redaction log. The referenced records' attachments are
// test-corpus files plus synthetic media from make-media.ps1, placed in the Mock RMS folder of the run's data root.
//
//   aft run platforms/agenticfoia/tours/main.tour.mjs [--engine Placeholder] [--skip-build]

import {
  build, findTesseract, freshData, launch, makeMedia, manifest, openVideo, pending, pickReview, placeRecords, pronounce,
  recordFileCount, requireSpeechModels, reviewClient, reviewerInit, rmsRecords, sceneExport, sceneGrid, sceneReview,
  sceneStartReview, sceneVideo, seedRequests, settings, isText,
} from '../app.mjs';

const REVIEW_FILE = '008-incident-report.txt';
const EXPORT_FILE = '006-incident-report.pdf';

export default {
  platform: 'agenticfoia',
  name: 'agenticfoia-main',
  script: '../scripts/main.md',
  pronounce,
  async record(ctx) {
    const s = await settings(ctx);
    requireSpeechModels(s);
    findTesseract(s);
    const bins = await build(ctx, s);
    const dataRoot = freshData(ctx, s);
    const media = await makeMedia(ctx);
    const records = rmsRecords();
    placeRecords(dataRoot, records, { corpus: s.corpus, mediaDir: media.dir });
    const truth = manifest(s).files.find(f => f.file === REVIEW_FILE);

    const stop = await launch(ctx, s, { ...bins, dataRoot });
    try {
      const { requestId, requestNumber } = await seedRequests(s, records);
      ctx.log(`record request ${requestNumber}`);
      const rc = reviewClient(s, requestId);
      const t = ctx.tour;
      const page = await t.start({ initScripts: [reviewerInit] });
      await page.goto(s.web);
      await page.locator('.queue-table tbody tr').first().waitFor();

      // 1. The Records Requests grid while the problem is described.
      await t.scene('scene-01', () => sceneGrid(t));

      // 2. The request (opened off camera): start a review, import the referenced records, open the file list.
      await page.goto(rc.requestPage());
      await page.locator('.record-title h1').waitFor();
      await t.scene('scene-02', () => sceneStartReview(t, rc, { importAt: 0.18, open: 0.4, rows: 0.6 }));

      ctx.log('waiting for analysis…');
      await rc.waitForAnalysis(recordFileCount(records));

      // 3. The text report: approve one item, deny an officer name (a "keep" value) if proposed, add a missed value,
      // then move a rule up to the review.
      const textDoc = await rc.docId(REVIEW_FILE);
      const v = await rc.view(textDoc);
      const { items, deny, manual } = pickReview(v, truth);
      const approve = items.find(i => i !== deny && /ssn|social/i.test(i.finding.category)) ?? items.find(i => i !== deny);
      ctx.log(`review: approve ${approve?.id ?? '-'}, deny ${deny?.id ?? '-'}, add ${manual ? `"${manual.text}"` : '-'}`);
      await page.goto(rc.docPage(textDoc));
      await page.locator('ol.items li.item').first().waitFor();
      await t.scene('scene-03', () => sceneReview(t, { approve, deny: deny && { item: deny, note: 'Officer name, public record' }, manual },
        { approve: 0.12, approveClick: 0.3, deny: 0.36, manual: 0.44, rule: 0.72, ruleClick: 0.8, end: 0.92 }));

      // 4. The body-camera video: play, approve a spoken name, draw a box over the licence plate.
      const videoDoc = await rc.docId(media.info.video);
      const vv = await rc.view(videoDoc);
      const spoken = pending(vv).find(i => isText(i) && /name/i.test(i.finding.category)) ?? pending(vv)[0];
      await openVideo(t, rc.docPage(videoDoc));
      await t.scene('scene-04', () => sceneVideo(t, spoken, media.info));

      // 5. Export the PDF report (the rest approved off camera) and compare it with the original.
      const pdfDoc = await rc.docId(EXPORT_FILE);
      await rc.approveRest(pdfDoc);
      await page.goto(`${rc.docPage(pdfDoc)}/export`);
      await page.locator('forge-button', { hasText: 'Export & mark complete' }).waitFor();
      await t.scene('scene-05', () => sceneExport(t, s, rc.docApi(pdfDoc), { compare: 0.4 }));

      // 6. The redaction log for that export.
      await t.helper(`${s.web}/tour/log.html?url=${encodeURIComponent(`${rc.docApi(pdfDoc)}/export/log`)}&name=${encodeURIComponent(EXPORT_FILE)}`, 30000);
      await t.scene('scene-06', async () => {
        await t.at(0.25);
        await page.mouse.move(960, 700, { steps: 30 });
        await page.mouse.wheel(0, 400);
        await t.at(0.6);
        await page.mouse.wheel(0, -400);
      });

      await t.finish({ requestId, reviewId: rc.reviewId });
    } finally {
      stop();
    }
  },
};
