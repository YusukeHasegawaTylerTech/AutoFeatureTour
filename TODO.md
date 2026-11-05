# TODO

Planned engine work. UI-side items are in [ui/TODO.md](ui/TODO.md). Build in this order: 1 and 2 together (artifact
cleanup depends on the ledger), then 3, then 4.

## 1. Repeatable runs: discrete setup and teardown

Today a fixture has `setup` / `teardown` hook lists; teardown runs after the browser closes if setup ran. Gaps: a
setup that fails halfway undoes nothing; a crash, kill or failed teardown leaves data behind and nothing remembers it;
nothing can say "make sure this exists" (setup either always creates or assumes the data is there, like RMS case 2106
with three reports); browser setup steps have no browser cleanup; validate and run mutate data back to back.

- **Paired items**: a fixture item `{ "setup": hook, "teardown": hook }` (keep the old lists working). Run in order,
  undone in reverse, and only the ones that ran are undone.
- **Ledger**: `<run>/ledger.json`, each item written *before* it runs (pending → done → undone / undo failed), so a
  killed process still leaves a record. Ctrl+C runs pending undo steps, with a time limit.
- **`aft cleanup [<run>] [--platform p] [--all]`**: finds runs with undo steps still pending (crashed, interrupted,
  teardown failed) and runs them. The start of a run does this for its own fixtures, so a rerun after a crash is safe.
- **Check before setup**: an item may have `check` (a hook, or browser checks). It holds → setup skipped, reported as
  "already in place". It fails after setup → a setup failure (its own class or SCRIPT), not a CRITERION failure later.
- **Browser cleanup**: fixture `cleanupSteps`, off camera after the last scene and before the browser closes; they
  also run when a scene failed.
- **Report**: report.json `fixtures` (each item: already in place / set up / undone / undo failed). A failed undo is a
  review finding ("leftover data: …"), with the usual decisions.
- Tests: partial setup failure undoes only what ran; kill mid-run → `aft cleanup` finishes the undo; check skips setup.

## 2. Artifacts: what a run created, pinned and referenced

The script decides what is pinned (deterministic run path); the tool only suggests.

- **`pin` step**: `{ "pin": "newAccount", "role": "account", "fields": { "username": L, "id": { "capture": { "url":
  true }, "pattern": "/users/(\\d+)" } }, "secret": ["password"], "cleanup": [steps | hook] }`. Builds on `capture … as`
  / `{vars.x}`: a pin is a named group of captured values with a role, a source and an undo.
- **Setup hooks as artifacts**: a hook's output can be pinned (`"pin": "account"`), shown as "created by setup".
- **References**: `{artifact.newAccount.username}` in later steps, scenes, teardown and cleanup; by role
  `{artifact[account].username}` = the latest of that role (for fragments: "sign in as the account this story made").
  An unknown artifact or field is a SCRIPT failure, like an uncaptured `{vars.x}`.
- **Secrets**: `secret` fields are redacted everywhere (report, bundle, captions), like `"secret": true` steps.
- **Cleanup**: an artifact's `cleanup` joins the ledger when the pin is made, so "created an account in step 4, then
  crashed" is exactly what `aft cleanup` deletes later.
- **Board data**: `<run>/artifacts.json` (id, role, fields with secrets masked, scene/step that made it, a cropped
  screenshot of the element it came from, cleanup status) and report.json `artifacts`.
- **Suggestions**: the review proposes pins ("step 4 created something new: a new id in the URL, a new row: pin it?")
  as findings; `generate` proposes `pin` steps when a story creates something. Never pinned automatically.
- Export/import: pins travel with the tour; artifact values never do.

## 3. Off camera scenes and steps

- `"camera": false` on a scene or a step: it runs for real (unpaced, no narration needed), is still checked and in the
  report and storyboard (marked "off camera"), and is cut from the video (the recorder's wait-trimming cut). Fixture
  steps are "off camera before scene 1".
- A scene off camera needs no narration; validation stops requiring it there.
- Tests: an off-camera scene leaves no clip and no caption, and its checks still count.

## 4. Shared environments and run tags

- **`{run.tag}`** (e.g. `aft-1105-kczy`) usable in anything a tour creates, so teardown deletes exactly this run's
  data and parallel runs on a shared environment don't collide; `aft cleanup --tag <prefix> [--older-than 2d]` sweeps
  leftovers.
- **`"shared": true`** on an environment (QA): fixtures and pins there must use `{run.tag}` or be marked read-only;
  validate warns when a tour creates data untagged there.
- **`"reset"`** on a local environment (e.g. restore a database snapshot): a hook run before a batch of runs, never on
  a shared environment.
- Later: `"scope": "session"` fixtures, set up once per session or UI batch instead of once per run.
