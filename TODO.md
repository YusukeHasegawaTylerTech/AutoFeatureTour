# TODO

Planned engine work. UI-side items are in [ui/TODO.md](ui/TODO.md).

- **Generate as a conversation**: implemented; open follow-ups in
  [TODO-generate-conversation.md](TODO-generate-conversation.md).
- **`"scope": "session"` fixtures**: set up once per session or UI batch instead of once per run.
- **Browser checks for hook items**: an item's `check` is a hook only. Browser checks exist per fixture
  (`checkSteps`), not per item.
- **Ledger secrets**: `ledger.json` keeps what an undo needs, including values it references. It is in the run
  folder, not in the triage bundle. Consider scrubbing secret artifact fields that no undo uses.
- **Ctrl+C on Windows**: the undo-on-signal path isn't covered by a test (killing a child process there skips signal
  handlers). The kill → `aft cleanup` path is tested.

## From the RMS-6445 tours (2026-11-05)

Found while building `platforms/rms-qa/tours/RMS-6445*.tour.json` (RMS review of Report Writing field reports on qa1).
App and environment findings are in `platforms/rms-qa/notes/rms-rw-findings.md`; these are AFT's own.

- **Multi-site tours**: a tour that spans two apps (RMS and the Report Writing cloud client) needs code steps today
  (`open-report-writing.mjs`, `sign-out-*.mjs`), because `goto` is relative to one baseUrl and absolute URLs are
  refused. Wanted: a named second site per platform/environment (`"sites": { "rw": "https://…" }`, `{ "goto": "rw:/path" }`),
  and per-site login roles.
- **Switching accounts mid-tour**: one tour, several users (setup officer, supervisor, reviewer) in the same app.
  Wanted: a `{ "signInAs": "<role>", "site": "…" }` step that clears that site's session and runs the role's login
  steps on camera (or off camera with `"offCamera": true`), and reports which account did which scene.
- **Expected rejections as a step**: "click X; the app is expected to refuse with message M" is a common way to film a
  finding. Wanted as a built-in step (`{ "click": …, "expectMessage": "/…/", "show": 4 }`) instead of a code step,
  reported as the criterion's result.
- **Resume a recording**: `--from-step` plays earlier steps fast, so a fix late in a long tour means a full re-record.
  Wanted: resume from a saved state (storage + vars) and stitch the video, or record scenes as separate clips that can
  be re-shot one at a time.
- **Captured values across tours**: setup and review could be separate tours if a run could export `vars` (incident
  number, record ids) for another tour to import (`"fromRun": "<tour>"`).
- **Locks and leftovers**: an interrupted review leaves an app-side lock ("locked for Review by …") that breaks the
  next try. A platform-level `cleanup` hook per scene type (cancel review, release lock) run on failure.
- **Findings in the result view**: the testing UI (`ui/`) should show a run's findings, not only pass/fail: known app
  issues (`knownIssue` steps), criteria that can't be shown on screen (with the reason), environment notes (accounts,
  required setup), and story gaps (criterion vs server behaviour). Each with its evidence (scene still, timestamp in
  the video, report entry), a status (open / reported / fixed), and a "copy for Jira" action. Also show the platform's
  notes file (below) next to its tours, and offer "add this finding to the platform notes".
- **Platform notes, the rest**: notes are now read by `aft generate`, exported/imported with tours, snapshotted into
  each run (`notes.md`) and the triage bundle. Still open: the UI showing a run's findings and the platform's notes
  (status open / reported / fixed, evidence, "copy for Jira"); report.json `findings` plus `aft notes add <run>`;
  `aft platform export/import` (`<p>.aft-platform.json`, no credentials); exporting only the notes the story touches.
