# AgenticFOIA tour: the complete walkthrough

Audience: a manager, with enough detail for a technical lead. Eleven scenes, about 6½ minutes at the default SAPI rate.
Recorded with `aft run platforms/agenticfoia/tours/full.tour.mjs --face-photo <portraits.png>` (from the AutoFeatureTour
repo). It covers the RMS record request workflow (scenes 1–3, 10–11, as in `rms.md`) plus
every kind of file: a typed report with an approval, a denial and a manual redaction; a photo read by OCR; a scanned
PDF with tables and ID photos (OCR plus face detection, as in `pdf-ocr.md`); and audio and video.

The scanned PDF is made by `platforms/agenticfoia/make-scan.cs --form <photo>` when `--face-photo` is given (the image is
read where it is), or taken from `--scan-file` / `--form-truth`, or reused from the newest earlier pdf-ocr run folder under
`out/agenticfoia-pdf-ocr/` that holds `014-witness-statement-scanned.pdf` and `form-truth.json`. It needs the detection
models (`--detection-models`). The records module is
a **Mock RMS**; scene 11 explains how it is replaced by the real one. All data is synthetic.

## 1. The problem
*App: the Records Requests grid, with the Mock RMS badge*

Public records requests take clerks hours. Every report, email, scanned form, photo, and body camera video has to be read line by line, with names, Social Security numbers, and phone numbers blacked out by hand. Agentic FOIA is a proof of concept that does the reading for them, so the clerk only has to check the results. It starts where the clerk already works: the records requests in RMS. RMS isn't connected yet, so a mock records module stands in for it, and it is labelled as a mock everywhere it appears.

## 2. Open the record request
*App: open a request; General, then Referenced Records*

The clerk opens a request. The requestor, type, due date and assignee all come from the record request, just as they appear in RMS. The Referenced Records tab lists the incident and case the requestor asked for, with everything attached to them: typed reports, a Word document, an email, a call log, a scanned witness statement, a photo, a 911 call and body camera video. The clerk doesn't have to find or download any of these files.

## 3. Start a redaction review
*App: Redaction Review tab; Start redaction review, then Import from referenced records*

With one click the clerk starts a redaction review, and with another imports every document from the referenced records. The app reads all of them in the background. Scans and photos are read with text recognition, and recordings are turned into text by an AI speech recognition model. Both run inside the app itself, so images and recordings are never sent anywhere. The request's details are passed along as context, but the requestor's name and contact details never are.

## 4. Review the suggestions
*App: review page of the typed report; approve one, deny one with a note, add one by hand, then "⇧ review" on a file rule*

Next, an AI language model reads that text along with the agency's redaction rules. For each file, it suggests what to redact and explains why. Only the text goes to the model, and in production it will go through a CJIS-compliant gateway. The clerk approves a Social Security number with one click. The next suggestion doesn't need redacting, so the clerk denies it and notes why. Denials are recorded too, and the AI is shown them the next time it reads this file. Then the clerk selects a name the model missed and adds it by hand. If a name is redacted once, the app suggests it everywhere else in the request. Each decision can become a rule, and with one click the clerk can move a rule up to the whole review. The clerk always makes the final decision.

## 5. Photos
*App: review page of the evidence photo; select and approve the suggestions on the image*

Photos work the same way. Text recognition, running on this machine, reads every word in the picture and where it is. Here, a handwritten evidence note shows a phone number and a name. When the clerk selects a suggestion, its box is highlighted on the photo. Approved words are painted black in the pixels when the photo is exported, and the photo's hidden metadata, such as GPS location, is removed.

## 6. Scanned PDFs
*App: review page of the scanned statement; recognized text, approve suggestions; the Page images card: approve the detected face, draw a box over the photo it missed*

Many records arrive as scans, and to a computer a scan is only a picture with no text at all. So for each page without real text, the app draws the page as an image and reads it with Tesseract, an open source text recognition engine, including words inside table cells. From then on, the scan is reviewed exactly like a typed report. Each page is also checked by a face detector, YuNet, also running locally. It found the face in the first ID photo and suggests blacking it out, and the clerk approves it. The second photo is a small, faded photocopy that the detector missed, so the clerk draws a box over it on the page. Detection only helps; the clerk still looks at every page.

## 7. Audio and video
*App: media viewer playing the body camera video; approve a spoken name; draw a box over a license plate*

Recordings work the same way. Redacted words are silenced in the audio, and text shown on screen is blacked out. The app also uses AI image detection, running inside the app, to find faces, people, and vehicles, and suggests blacking them out. The clerk can draw a box over anything else, such as a license plate.

## 8. Export
*App: export page of the typed PDF, then the original and redacted copy side by side*

When a file is finished, the clerk exports it. It comes back in the same or a standard format, looking like the original, but with the redacted content truly removed, not covered by a box that could be lifted off. A PDF is rebuilt from images, with no hidden text layer and no metadata. AI plays no part in the export: only the redactions the clerk approved are applied.

## 9. The scan and the photo, redacted
*Tour pages: the scanned PDF side by side, page 1 then page 2; then the photo side by side*

The scanned statement is redacted the same way. The app checks the file's fingerprint, draws each page again, paints over every approved word and face, and then reads the result once more. If any approved word can still be read, the export is refused. On the second page, the table cells with personal details and both faces are gone, while the officer's name and badge number stay, because they are public. The photo comes back with the same words painted out in its pixels.

## 10. Sign off and write back
*App: Redaction Review tab, Approve packet; then Documents, General and Event Log; then the combined redaction log*

Once every file is reviewed and exported, the clerk approves the response packet. Nothing can be released until that happens, and it is always a person who signs off. The packet, with the redacted files and one combined redaction log, is filed back on the record request. The request moves to done, with the date responded and the time spent on the review filled in, and every step appears in the request's event log. The log shows what was redacted, why, who approved or denied it and when, but never the redacted text itself.

## 11. Slotting into RMS
*Tour page: the records-system seam, Mock RMS today, RMS adapter tomorrow*

Everything that crosses between the app and the records module goes through one narrow interface. Today the mock implements it, using the same field names and shapes as the RMS records module. To go live, an RMS adapter implements the same interface over the RMS records API: it reads the request and its referenced records' attachments, and writes back events, status, time spent and the response packet. The review screens, the redaction engine and the exports don't change. Within RMS, this can open from a Redaction Review section on the record request, under the user's own login. The goal is to cut the time per request by more than half, so clerks can handle twice as many requests, while making redaction more accurate. Thanks for watching.
