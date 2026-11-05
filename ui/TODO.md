# UI TODO

## Simple screens
- Untested in the new screens: MAKE VIDEO end to end; saving GENERATE output and checking it (the planner wrote a
  `goto: "/todomvc/#/"` that may double the base URL's path).
- Point-and-click steps: a live browser (session pane: snapshot / locate / try-step) where you click the element and
  pick "click" / "type into"; the picker's Click / Type then fill the target for you.
- Friendly names for `{data.x}` values in steps (show the fixture's value).
- Show the narration's spoken length vs. the scene's steps (scene overruns).
- A trash view to restore deleted items (the server already moves them to `out/.trash/<stamp>/`; no restore yet).
- Video: scene markers.
- Pin steps are shown read-only in the simple editor (name, fields, whether they have a cleanup); writing a pin's
  fields and cleanup still means editing the raw file.

## Advanced screens
- Schema-driven forms for platform.json / environments.json instead of raw text.
- Compare a run with the previous run of the same script.

## Housekeeping
- Tests for `ui/server.mjs` (path limits, token, `/api/secret` only writes referenced names, trash, ledger summary).
- Decide whether `aft ui` becomes a CLI command (today: `npm run ui`).
- `listRuns` still reads validation.json to mark old dry runs failed; runs from now on say so in run.json itself.
