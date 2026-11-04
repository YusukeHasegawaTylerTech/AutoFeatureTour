# AgenticFOIA: scanned PDF tour, narration script

Audience: a manager, with enough detail for a technical lead. Eight scenes, about 4½ minutes at the default SAPI rate.
The italic lines are the capture cues. Build the video with:

`aft run platforms/agenticfoia/tours/pdf-ocr.tour.mjs --face-photo <image> --detection-models <folder>` (from the
AutoFeatureTour repo)

That narrates this file and records `platforms/agenticfoia/tours/pdf-ocr.tour.mjs` in the real app. The scan is attached
to a referenced case record of a Mock RMS record request, and the tour imports it from there.
`platforms/agenticfoia/make-scan.cs --form` makes the sample, a two-page image-only scan, and writes the ground truth of
page 2 to `form-truth.json` next to it in the run folder (the full tour can reuse the pair):
- Page 1 is corpus file `014-witness-statement.pdf`, rendered, tilted and tinted.
- Page 2 is a synthetic "persons involved" and property form with two tables and two ID photos.

The photos are cropped from `--face-photo` to the faces only, with no names or overlays. The image is read from where
it is and never copied into the repo. The first photo is a clear print. The second is a small, faded photocopy, which
the face detector misses in practice (the recorder checks this and boxes whichever photo really was missed). All text
on both pages is fictional.

Presenter notes (not narrated):
- `PdfFormat.Extract`: pages whose PdfPig text is blank are rendered at `Export:PdfDpi` (200) with PDFium and OCR'd with
  Tesseract (TSV output: word, line, box). That gives one segment per page. Every page also goes to the face and object
  detector (YuNet + SFace + YOLOX, in the `detector` child process). Words and detections are saved as a `MediaLayout`
  in `extracted.json`, pinned to the SHA-256. Each box's `T` is its page number.
- Detections are pending `Region` items. The review page's "Page images" card (`pdf-pages.ts`) draws them over
  `GET …/pages/{n}`, and a drag adds a manual region on that page.
- `PdfFormat.Redact`: text-layer pages must re-extract exactly. Scanned pages must match the hash and still have no text
  layer. Word and region boxes are painted with SkiaSharp (plus `Media:BoxPaddingPixels`), and every page is rebuilt
  from PNGs with PdfPig, so there is no text layer and no metadata.
- Leak check (`Media:VerifyMediaExports`, on by default): the redacted scanned pages are OCR'd again, and the export is
  refused if any approved text is found.

## 1. A scan is only a picture
*Helper page: the scanned packet; the counters show zero readable characters; type a name into the search box*

Many records reach the clerk as scans: a signed witness statement, a faxed form, or a page photographed at the front desk. This packet has two pages: a witness statement, and a form with tables of people and property, including ID photos. To a computer, all of it is only pictures. The file contains zero characters of text. Search finds nothing, and a redaction tool that reads text would see blank pages and redact nothing.

## 2. Import the scan
*App: the record request's Redaction Review tab; start a review and import the scan from the referenced case record*

So the clerk handles it like any other file. The scan is attached to the case record the request refers to, so the clerk starts a redaction review and imports it with one click. The import only stores the file. Reading it happens in the background, so the clerk can keep working while it runs.

## 3. Reading the page
*App: the review page with its OCR warnings and recognized text; then the helper page drawing each recognized word's box over the scan*

For every page, the app first asks: does this page have real text? If it does, that text is used directly. If not, the page is drawn as an image at two hundred dots per inch and read by Tesseract, an open source text recognition engine that runs on this machine, so the scan never leaves it. Tesseract returns every word together with its exact box on the page, including the words inside table cells. The app saves those boxes with the file, tied to a SHA-256 fingerprint of the original. Each page is also marked as read by recognition, so the clerk knows to check it against the scan.

## 4. Review, the same as any file
*App: the review page; approve the suggestions, add the name the engine missed*

From here, a scan is reviewed exactly like a typed report. The recognized text, and only the text, goes to the AI language model with the agency's redaction rules. In production, that goes through the CJIS-compliant gateway. The model suggests what to redact and why: dates of birth, phone numbers, an email and home addresses. The clerk approves or denies each one. The model missed the witness's name, so the clerk selects it in the recognized text and adds it by hand. That is why a person always reviews every file.

## 5. Faces in photos
*App: the Page images card; approve the detected face; draw a box over the photo the detector missed*

Text isn't the only thing to protect. Each page is also checked by a face detector, YuNet, which also runs on this machine. It found the witness's face in the first ID photo and suggests blacking it out. As with every suggestion, nothing happens until the clerk approves it. But the second photo is a small, faded photocopy, and the detector missed it. So the clerk simply draws a box over it on the page image, and it is added to the redactions just like the others. Detection only helps. The clerk still looks at every page.

## 6. How the export is built
*Helper page: the ten-step pipeline, lit up one step at a time*

When the clerk exports, the app doesn't read the page a second time, because recognition can come out slightly different each time. Instead, it checks the fingerprint. If the file has changed since it was read, the export stops. It draws each page again at the same resolution, so the saved word and face boxes line up exactly. Then it paints solid black into the pixels over every approved word and every approved face. Finally, it builds a brand-new PDF from those images alone, with no hidden text layer and no metadata. Last of all, Tesseract reads the finished pages once more, and if any approved word can still be read, the export is refused.

## 7. The result
*App: export the file; then the original and the redacted pages side by side, page 1 and then page 2*

Here is the result. On the left is the original scan, which is never released. On the right is the export. It looks the same, but the names, dates of birth, phone numbers and addresses are gone from the pixels themselves, not covered by a box that could be lifted off. On the second page, the table cells holding personal details are blacked out, and so are both faces: the one the detector found, and the one the clerk drew. The officer's name and badge number stay, because they are public. AI plays no part in this step: only what the clerk approved is removed.

## 8. The audit trail
*Helper page: the redaction log for the export*

Every export comes with a redaction log: what was removed, the category, the reason, the page, who approved it and when, including the faces. The log never contains the redacted text itself. Scanned pages, tables and photos now get the same review, the same leak protection and the same audit trail as every other file. Thanks for watching.
