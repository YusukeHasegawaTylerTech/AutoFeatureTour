# UI TODO

## Engine bugs found from the UI (fix in `src/`, on main)
- `aft platform check --json` reports `"ok": true, "class": "ok"` while exiting 1 with `data.ok: false` (e.g. "nothing
  answers at http://localhost:9/"). The UI works around it (trusts the exit code and `data.ok`).
- `aft validate` writes `run.json` `"status": "done"` even when steps fail; the verdict is only in `validation.json`
  (`blocking`). The UI reads validation.json; run.json (and `out/<name>/latest.json`, which points at it as a success)
  should say failed.

## Simple screens
- Untested in the new screens: MAKE VIDEO end to end; saving GENERATE output and checking it (the planner wrote a
  `goto: "/todomvc/#/"` that may double the base URL's path).
- Point-and-click steps: a live browser (session pane: snapshot / locate / try-step) where you click the element and
  pick "click" / "type into"; the picker's Click / Type then fill the target for you.
- Friendly names for `{data.x}` values in steps (show the fixture's value).
- Show the narration's spoken length vs. the scene's steps (scene overruns).
- A trash view to restore deleted items (they are moved to `out/.trash/<stamp>/`, never erased).
- Video: scene markers, download button.

## Advanced screens
- Schema-driven forms for platform.json / environments.json instead of raw text.
- Compare a run with the previous run of the same script.

## Housekeeping
- Tests for `ui/server.mjs` (path limits, token, `/api/secret` only writes referenced names, trash).
- Commit the `ui` worktree; decide whether `aft ui` becomes a CLI command.

## Planned with the engine work (see ../TODO.md)
- Run page: an **Artifacts** board (each pinned artifact: role, id, fields with secrets as ●●●, "created in scene 2,
  step 4" linking to the step, a cropped screenshot, cleanup status) and a **Setup / teardown** strip (scene 0 and N+1
  in the storyboard: each fixture item already in place / set up / undone / undo failed).
- Review: "leftover data" findings from failed undo steps; "pin it?" suggestions with a button that adds the `pin` step.
- Editor: a 🎥 on/off-camera toggle per scene and step; a picker for `{artifact.x.field}` references.
- Platforms: an environment's `shared` / `reset` shown on its page; a CLEAN UP button (`aft cleanup`) per platform.
