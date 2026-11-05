# TODO

Planned engine work. UI-side items are in [ui/TODO.md](ui/TODO.md).

- **`"scope": "session"` fixtures**: set up once per session or UI batch instead of once per run.
- **Browser checks for hook items**: an item's `check` is a hook only. Browser checks exist per fixture
  (`checkSteps`), not per item.
- **Batches**: `--reset` runs before one run. A real batch runner (several tours, one reset) doesn't exist yet.
- **Ledger secrets**: `ledger.json` keeps what an undo needs, including values it references. It is in the run
  folder, not in the triage bundle. Consider scrubbing secret artifact fields that no undo uses.
- **Ctrl+C on Windows**: the undo-on-signal path isn't covered by a test (killing a child process there skips signal
  handlers). The kill → `aft cleanup` path is tested.
