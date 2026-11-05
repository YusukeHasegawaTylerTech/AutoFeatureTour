# UI TODO

## Simple screens
- GENERATE hasn't been tried end to end from the new screens (it needs `--llm claude`). Its output now goes through
  the goto check (paths that repeat the base URL's path become relative; other root paths are flagged).
- Pick from the page lists the names on the page next to its screenshot. Clicking *on the screenshot* to pick an
  element would need an engine primitive that maps a point to a target (snapshot has no coordinates).
- Scene timing is an estimate (words / 2.5 for the voice, a rough cost per step), plus the scene's length in the last
  video when there is one.

## Housekeeping
- `listRuns` still reads validation.json to mark old dry runs failed; runs from now on say so in run.json itself.
  Drop the fallback once dry runs made before ae7556a are gone.
