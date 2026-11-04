# AgenticFOIA tour: from an RMS record request to a signed-off response packet

Audience: a manager. Eight scenes, about 4 minutes at the default SAPI rate. Recorded with
`aft run platforms/agenticfoia/tours/rms.tour.mjs` (from the AutoFeatureTour repo; output in a run folder under `out/agenticfoia-rms/`).
The italic lines say what is on screen. The records module is a **Mock RMS** in this proof of concept; scene 8 explains
how it is replaced by the real one.

## 1. The problem
*App: the Records Requests grid, with the Mock RMS badge*

Public records requests take clerks hours. Every report, email, photo, and body camera video has to be read line by line, with names, Social Security numbers, and phone numbers blacked out by hand. Agentic FOIA is a proof of concept that does the reading for them, so the clerk only has to check the results. It starts where the clerk already works: the records requests in RMS. RMS isn't connected yet, so a mock records module stands in for it, and it is labelled as a mock everywhere it appears.

## 2. Open the record request
*App: open a request; General, then Referenced Records*

The clerk opens a request. The requestor, type, due date and assignee all come from the record request, just as they appear in RMS. The Referenced Records tab lists the incident and case the requestor asked for, and the reports, emails, photos, audio and video attached to them. The clerk doesn't have to find or download any of these files.

## 3. Start a redaction review
*App: Redaction Review tab; Start redaction review, then Import from referenced records*

With one click the clerk starts a redaction review, and with another imports every document from the referenced records. The app reads all of them in the background. For photos and video it uses text recognition to read words on screen, and an AI speech recognition model turns recordings into text. Both run inside the app itself, so photos and recordings are never sent anywhere. The request's details are passed along as context, but the requestor's name and contact details never are.

## 4. Review the suggestions
*App: review page; approve one item, deny one, add one by hand, then click "⇧ review" on a file rule*

Next, an AI language model reads that text along with the agency's redaction rules. For each file, it suggests what to redact and explains why, for example a Social Security number or a victim's name. Only the text goes to the model, and in production it will go through a CJIS-compliant gateway. The clerk approves or denies each suggestion with one click and can add anything that was missed. If a name is redacted once, the app suggests it everywhere else in the request too. Each decision can become a rule, and with one click the clerk can move a rule up to the whole review, so every other file follows it. The rules only guide the suggestions; the clerk always makes the final decision.

## 5. Audio and video
*App: media viewer playing the body camera video with a redaction*

Recordings work the same way. Redacted words are silenced in the audio, and text shown on screen is blacked out. Before export, the app checks the finished file again to make sure nothing redacted can still be seen or heard. The app also uses AI image detection, running inside the app, to find faces, people, and vehicles, and suggests blacking them out. The clerk can draw a box over anything else, such as a license plate.

## 6. Export
*App: export page, then a redacted PDF next to the original*

When a file is finished, the clerk exports it. It comes back in the same or a standard format, looking like the original, but with the redacted content truly removed, not just covered up. AI plays no part in the export: only the redactions the clerk approved are applied.

## 7. Sign off and write back
*App: Redaction Review tab, Approve packet; then Event Log, Documents and General*

Once every file is reviewed and exported, the clerk approves the response packet. Nothing can be released until that happens, and it is always a person who signs off. The packet, with the redacted files and one combined redaction log, is filed back on the record request. The request moves to done, with the date responded and the time spent on the review filled in, and every step appears in the request's event log. The log shows what was redacted, why, who approved it and when, but never the redacted text itself.

## 8. Slotting into RMS
*Tour page: the records-system seam, Mock RMS today, RMS adapter tomorrow*

Everything that crosses between the app and the records module goes through one narrow interface. Today the mock implements it, using the same field names and shapes as the RMS records module. To go live, an RMS adapter implements the same interface over the RMS records API: it reads the request and its referenced records' attachments, and writes back events, status, time spent and the response packet. The review screens, the redaction engine and the exports don't change. Within RMS, this can open from a Redaction Review section on the record request, under the user's own login. The goal is to cut the time per request by more than half, so clerks can handle twice as many requests, while making redaction more accurate. Thanks for watching.
