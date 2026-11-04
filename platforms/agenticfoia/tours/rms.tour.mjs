// AgenticFOIA record-request tour (scripts/rms.md): from a Mock RMS record request to a signed-off response packet,
// and how the records-system seam slots into RMS. Before the API starts, the referenced records' attachments
// (test-corpus files plus synthetic media from make-media.ps1) are placed in the Mock RMS folder of the run's data
// root; the record requests are then created through the Mock RMS API, as RMS would already hold them. Slow work
// between scenes (analysis, approving and exporting the other files) is off camera. Only synthetic data is used.
//
//   aft run platforms/agenticfoia/tours/rms.tour.mjs [--engine Placeholder] [--skip-build]

import {
  build, findTesseract, freshData, isText, launch, makeMedia, manifest, openVideo, pending, placeRecords, pronounce,
  recordFileCount, requireSpeechModels, reviewClient, reviewerInit, rmsRecords, sceneExport, sceneGrid, scenePacket,
  sceneRequest, sceneReview, sceneSeam, sceneStartReview, sceneVideo, seedRequests, settings,
} from '../app.mjs';

const REVIEW_FILE = '008-incident-report.txt';
const EXPORT_FILE = '006-incident-report.pdf';

export default {
  platform: 'agenticfoia',
  name: 'agenticfoia-rms',
  script: '../scripts/rms.md',
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

      // 1–3. The grid, the request and its referenced records, then a review started and the records imported.
      await t.scene('scene-01', () => sceneGrid(t));
      await t.scene('scene-02', () => sceneRequest(t, requestNumber, { refs: 0.45, first: 0.6, last: 0.8 }));
      await t.scene('scene-03', () => sceneStartReview(t, rc, { importAt: 0.22, open: 0.45, rows: 0.6 }));

      ctx.log('waiting for analysis…');
      await rc.waitForAnalysis(recordFileCount(records));

      // 4. The text report: approve one item, deny an officer name (a "keep" value) if the engine proposed one, and
      // add a planted value the engine missed by hand.
      const textDoc = await rc.docId(REVIEW_FILE);
      const v = await rc.view(textDoc);
      const keep = (truth?.keep ?? []).map(k => k.text ?? k);
      const items = pending(v).filter(isText);
      const denyItem = items.find(i => keep.some(k => i.finding.originalText.includes(k)));
      const approve = items.find(i => i !== denyItem && /ssn|social/i.test(i.finding.category)) ?? items.find(i => i !== denyItem);
      const covered = x => v.items.some(i => i.finding.originalText.includes(x) || x.includes(i.finding.originalText));
      const missed = (truth?.redact ?? []).find(r => !covered(r.text) && v.segments.some(g => g.text.includes(r.text)));
      const manual = missed ? { text: missed.text, category: missed.category } : null;
      const deny = denyItem && { item: denyItem, note: 'Officer name, public record' };
      ctx.log(`review: approve ${approve?.id ?? '-'}, deny ${denyItem?.id ?? '-'}, add ${manual ? `"${manual.text}"` : '-'}`);
      await page.goto(rc.docPage(textDoc));
      await page.locator('ol.items li.item').first().waitFor();
      await t.scene('scene-04', () => sceneReview(t, { approve, deny, manual },
        { approve: 0.12, approveClick: 0.3, deny: 0.38, manual: 0.48, rule: 0.76, ruleClick: 0.84, end: 0.93 }));

      // 5. The body-camera video.
      const videoDoc = await rc.docId(media.info.video);
      const vv = await rc.view(videoDoc);
      const spoken = pending(vv).find(i => isText(i) && /name/i.test(i.finding.category)) ?? pending(vv)[0];
      await openVideo(t, rc.docPage(videoDoc));
      await t.scene('scene-05', () => sceneVideo(t, spoken, media.info));

      // 6. Export the PDF report (the rest of it approved off camera) and compare it with the original.
      const pdfDoc = await rc.docId(EXPORT_FILE);
      await rc.approveRest(pdfDoc);
      await page.goto(`${rc.docPage(pdfDoc)}/export`);
      await page.locator('forge-button', { hasText: 'Export & mark complete' }).waitFor();
      await t.scene('scene-06', () => sceneExport(t, s, rc.docApi(pdfDoc), { compare: 0.4 }));

      // Off camera: approve what's left in every other file and export it, so the packet can be approved.
      await rc.finishAndExport(pdfDoc, { log: ctx.log });

      // 7. Sign off the packet on the record request and show what was written back to it.
      await page.goto(rc.requestPage('?tab=review'));
      await page.locator('.packet forge-button', { hasText: 'Approve packet' }).waitFor();
      await t.scene('scene-07', () => scenePacket(t, s, rc, { approve: 0.16, docs: 0.32, general: 0.46, events: 0.6, log: 0.78 }));

      // 8. How the records-system seam slots into RMS.
      await t.helper(`${s.web}/tour/rms.html`, 30000);
      await t.scene('scene-08', () => sceneSeam(t));

      await t.finish({ requestId, reviewId: rc.reviewId });
    } finally {
      stop();
    }
  },
};
