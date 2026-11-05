# TODO

Planned engine work. UI-side items are in [ui/TODO.md](ui/TODO.md).

- **Generate as a conversation**: implemented; open follow-ups in
  [TODO-generate-conversation.md](TODO-generate-conversation.md).
- **`"scope": "session"` fixtures**: set up once per session or UI batch instead of once per run.
- **Browser checks for hook items**: an item's `check` is a hook only. Browser checks exist per fixture
  (`checkSteps`), not per item.
- **Batches**: `--reset` runs before one run. A real batch runner (several tours, one reset) doesn't exist yet.
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
- **Long try-step batches**: the CLI call gives up ("fetch failed") while the session keeps working; there's no way to
  wait for or attach to the running call. Return a call id and add `aft session wait`, or stream progress.
- **Locks and leftovers**: an interrupted review leaves an app-side lock ("locked for Review by …") that breaks the
  next try. A platform-level `cleanup` hook per scene type (cancel review, release lock) run on failure.
- **Findings in the result view**: the testing UI (`ui/`) should show a run's findings, not only pass/fail: known app
  issues (`knownIssue` steps), criteria that can't be shown on screen (with the reason), environment notes (accounts,
  required setup), and story gaps (criterion vs server behaviour). Each with its evidence (scene still, timestamp in
  the video, report entry), a status (open / reported / fixed), and a "copy for Jira" action. Also show the platform's
  notes file (below) next to its tours, and offer "add this finding to the platform notes".
- **Platform notes as an input**: `platforms/<p>/notes/*.md` (structured findings, accounts, setup recipes) should be
  readable by `aft generate` and the review flow, so the next story on the same app starts from what was learned.
- **Notes travel with exports and runs**: platform notes (`platforms/<p>/notes/*.md`, `schema: aft-platform-notes/1`)
  should go wherever the platform's knowledge is needed:
  - `aft export <tour>` (`aft-export/1`): a `notes` array with the platform's notes (or only the findings and
    setup recipes the tour's story touches, by `area`/tag), so QA gets the accounts table and setup recipe with the
    tour. `aft import` writes them to `platforms/<target>/notes/imported/<source-platform>/` and lists findings the
    target's own notes don't have yet (match by `id`), without overwriting the target's notes.
  - A platform export (new: `aft platform export <p>` → `<p>.aft-platform.json`, no credentials, `.env` names only):
    platform.json, environments (URLs, no secrets), fragments, fixtures, mocks and notes, for setting the platform
    up on another machine; `aft platform import` the reverse, never overwriting without `--force`.
  - Every run folder: `notes.md` (the notes as they were when the run started, so a report reads against the
    knowledge of its time) and in the triage bundle / `PROMPT.md`, so whoever triages a failure sees the known
    accounts, setup and findings first.
  - report.json: `findings` from the run (known issues, criteria not shown on screen, story gaps) in the same
    shape as the notes' findings, with `aft notes add <run>` to merge them into the platform notes (new `id`s, status
    `open`, evidence = the run's still / video timestamp).
