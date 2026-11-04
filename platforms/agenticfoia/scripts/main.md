# AgenticFOIA proof-of-concept tour: narration script

Audience: a manager. Six scenes, about 3 minutes at the default SAPI rate. The italic lines are the capture cues.
Recorded with `aft run platforms/agenticfoia/tours/main.tour.mjs` (from the AutoFeatureTour repo). The work starts from
a **Mock RMS** record request; the longer record-request walkthrough is `rms.md`.

## 1. The problem
*App: the Records Requests grid, with the Mock RMS badge*

Public records requests take clerks hours. Every report, email, photo, and body camera video has to be read line by line, with names, Social Security numbers, and phone numbers blacked out by hand. Agentic FOIA is a proof of concept that does the reading for them, so the clerk only has to check the results. It starts from the records requests the clerk already works on, here in a mock records module.

## 2. Start a review
*App: a record request's Redaction Review tab; Start redaction review, Import from referenced records, Open review*

The clerk opens a request, starts a redaction review, and imports every file attached to the records it refers to: reports, Word documents, PDFs, emails, photos, audio, and video. The app reads all of them in the background. For photos and video, it uses text recognition to read words on screen, and an AI speech recognition model turns recordings into text. Both run inside the app itself, so photos and recordings are never sent anywhere.

## 3. Review the suggestions
*App: review page; approve one item, deny one, add one by hand, then click "⇧ review" on a file rule*

Next, an AI language model reads that text along with the agency's redaction rules. For each file, it suggests what to redact and explains why, for example a Social Security number or a victim's name. Only the text goes to the model, and in production it will go through a CJIS-compliant gateway. The clerk approves or denies each suggestion with one click and can add anything that was missed. If a name is redacted once, the app searches for it everywhere else in the review and suggests it there too. That search is exact matching, not AI. Each decision also becomes a rule for that file, such as always redact this name or never redact this officer. With one click, the clerk can move a rule up to the whole review, so every other file follows it the next time it's analyzed. The rules only guide the suggestions; the clerk always makes the final decision. Nothing is released without review.

## 4. Audio and video
*App: media viewer playing the body camera video with a redaction*

Recordings work the same way. Redacted words are silenced in the audio, and text shown on screen is blacked out. Before export, the app checks the finished file again to make sure nothing redacted can still be seen or heard. The app also uses AI image detection, running inside the app, to find faces, people, and vehicles, and suggests blacking them out. The clerk can draw a box over anything else, such as a license plate, which the app doesn't detect yet.

## 5. Export
*App: export page, then a redacted PDF next to the original*

When a file is finished, the clerk exports it. It comes back in the same or a standard format, looking like the original, but with the redacted content truly removed, not just covered up. AI plays no part in the export: only the redactions the clerk approved are applied.

## 6. Audit trail and close
*App: the redaction log*

Every export includes a log of what was redacted, why, who approved it, and when, ready if the release is ever challenged. The goal is to cut the time per request by more than half, so clerks can handle twice as many requests, while making redaction more accurate. Thanks for watching.
