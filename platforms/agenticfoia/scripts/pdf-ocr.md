# AgenticFOIA: scanned PDF tour, narration script

Audience: a manager, with enough detail for a technical lead. Seven scenes, about 3½ minutes at the default SAPI rate.
The italic lines are the capture cues. Build the video with:

`node src/cli.mjs platforms/agenticfoia/tours/pdf-ocr.tour.mjs --record` (from the AutoFeatureTour repo)

That narrates this file and records `platforms/agenticfoia/tours/pdf-ocr.tour.mjs` in the real app. The sample is a synthetic
scan made by `platforms/agenticfoia/make-scan.cs` from corpus file `014-witness-statement.pdf`: the page is rendered, tilted, tinted
and saved as an image-only PDF. Never use a real record.

Presenter notes (not narrated):
- `PdfFormat.Extract`: pages whose PdfPig text is blank are rendered at `Export:PdfDpi` (200) with PDFium and OCR'd with
  Tesseract (TSV output: word, line, box). That gives one segment per page and a `MediaLayout` in `extracted.json`, pinned
  to the SHA-256.
- `PdfFormat.Redact`: text-layer pages must re-extract exactly. Scanned pages must match the hash and still have no text
  layer. Boxes are painted with SkiaSharp (plus `Media:BoxPaddingPixels`), and every page is rebuilt from PNGs with
  PdfPig, so there is no text layer and no metadata.
- Leak check (`Media:VerifyMediaExports`, on by default): the redacted scanned pages are OCR'd again, and the export is
  refused if any approved text is found.

## 1. A scan is only a picture
*Helper page: the scanned witness statement; the counters show zero readable characters; type a name into the search box*

Many records reach the clerk as scans: a signed witness statement, a faxed form, or a page photographed at the front desk. To a computer, a scan is only a picture of a page. This witness statement has a name, a phone number and a home address on it, but the file contains zero characters of text. Search finds nothing, and a redaction tool that reads text would see a blank page and redact nothing.

## 2. Upload the scan
*App: create a project and drop the scanned PDF onto it*

So the clerk handles it like any other file. They create a project for the request and drop the scan in. The upload only stores the file. Reading it happens in the background, so the clerk can keep working while it runs.

## 3. Reading the page
*App: the review page with its OCR warning and recognized text; then the helper page drawing each recognized word's box over the scan*

For every page, the app first asks: does this page have real text? If it does, that text is used directly. If not, the page is drawn as an image at two hundred dots per inch and read by Tesseract, an open source text recognition engine that runs on this machine, so the scan never leaves it. Tesseract returns every word together with its exact box on the page. The app saves those boxes with the file, tied to a SHA-256 fingerprint of the original. The page is also marked as read by recognition, so the clerk knows to check it against the scan.

## 4. Review, the same as any file
*App: the review page; approve the suggestions, deny an officer's name, add anything the engine missed*

From here, a scan is reviewed exactly like a typed report. The recognized text, and only the text, goes to the AI language model with the agency's redaction rules. In production, that goes through the CJIS-compliant gateway. The model suggests what to redact and why: here, a date of birth, a phone number, an email and two home addresses. The clerk approves or denies each one. The model missed the witness's name, so the clerk selects it in the recognized text and adds it by hand. That is why a person always reviews every file.

## 5. How the export is built
*Helper page: the ten-step pipeline, lit up one step at a time*

When the clerk exports, the app doesn't read the page a second time, because recognition can come out slightly different each time. Instead, it checks the fingerprint. If the file has changed since it was read, the export stops. It draws the page again at the same resolution, so the saved word boxes line up exactly. Then it paints solid black into the pixels over every approved word, slightly wider than the word itself. Finally, it builds a brand-new PDF from those images alone, with no hidden text layer and no metadata. Last of all, Tesseract reads the finished page once more, and if any approved word can still be read, the export is refused.

## 6. The result
*App: export the file; then the original and the redacted page side by side*

Here is the result. On the left is the original scan, which is never released. On the right is the export. It looks the same, but the name, date of birth, phone number and addresses are gone from the pixels themselves, not covered by a box that could be lifted off. Nothing was left that the final check could read. AI plays no part in this step: only what the clerk approved is removed.

## 7. The audit trail
*Helper page: the redaction log for the export*

Every export comes with a redaction log: what was removed, the category, the reason, the page, who approved it and when. The log never contains the redacted text itself. Scanned pages now get the same review, the same leak protection and the same audit trail as every other file. Thanks for watching.
