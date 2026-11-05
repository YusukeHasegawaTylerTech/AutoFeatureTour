# AutoFeatureTour UI

A local web UI over the files and the CLI. It opens on the script list, made for someone who has never used the tool:
every app with its scripts, a dashed **NEW SCRIPT** tile closing each app's row and **NEW APP** last; everything else
(runs, platforms, raw files, jobs, doctor) is in the ☰ menu.

```
aft ui                                      # or: npm run ui, or node ui/server.mjs [--port 4777] [--no-open] [--root <checkout>]
```

It opens the browser with a one-time token in the URL (kept as a cookie). The server listens on 127.0.0.1 only.

- **NEW SCRIPT** (per app) / **NEW APP** ( name, web address, how its sign-in page looks, test username/password,
  TEST THE CONNECTION), name the script, then write scenes: title, narration, and steps picked from six picture buttons (🎥 on a scene or step turns it off camera; 📌 next to a field inserts a value an earlier pin step made, `{artifact.x.field}`)
  (open a page, click, type, press a key, check it shows, wait). **GENERATE** writes the scenes from a pasted story
  (`aft generate --llm claude`: sends the story and the app's screens to Claude).
- **Script list** (the start page, also `#/browse`): every script as a tile (works / needs fixing / not tried); a script's page has CHECK IT (dry run), MAKE
  VIDEO and EDIT, and explains a failure in plain words with one next step (USE the suggested name, FIX IT, …).
- **EXPORT / IMPORT** (dev to QA): EXPORT on a script's page runs `aft export` and downloads its `.aft.json`
  (fragments inlined, the script's last passing run or check as evidence). IMPORT is a drop zone (drag the file in, or
  click to choose it): on the start page it asks which app to import into; on an app's NEW SCRIPT page it imports
  into that app. It shows where the script came from and its criteria, runs `aft import`,
  offers REPLACE IT when the app already has a script of that name, and lists missing fixtures. Dropped files are kept
  in `out/.imports/<stamp>-<id>/`; `import` only reads files from there.
- **Sign-in details**: username/password fields write the platform's `{env:…}` names into the checkout's `.env`
  (git-ignored). Values are never sent back to the page.
- **Review** (on a run's page, above the storyboard): the verdict (passed · passed with known issues · needs review ·
  failed · failed: app issue), evidence per criterion with the reasons, and every finding with buttons: ✏️ FIX THE
  SCRIPT, ✨ AI FIX (`aft suggest-fix`: a proposed step or workaround, shown before/after; USE or DISCARD), 🩹 REAL
  ISSUE: WORK AROUND IT FOR NOW (a story workaround) or EXPECT IT TO FAIL FOR NOW (a check's `knownIssue`), 🐞 REAL
  ISSUE: LEAVE IT FAILING, ✔ GOOD ENOUGH / EXPECTED HERE, ↩ UNDO; leftover test data: 🧹 CLEAN UP NOW (`aft cleanup <run>`); "pin it?": 📌 PIN IT (adds the proposed `pin` step after the step that made the record). Decisions are written into the tour that ran
  (`review.decisions`); the platform is never edited from here.
- **Runs**: every `out/<name>/<run>/run.json`; a run shows a **Scenes** storyboard (per scene: its still, title,
  narration, "open in the app ↗" for its URL, every step with ✔/✘, errors and "did you mean", ✏️ to that step in the
  editor; validation.md stays below, collapsed; a **Setup** strip before scene 1 and a **Teardown** strip after the
  last show each fixture item: already in place, set up, undone, undo failed; off-camera scenes and steps are marked 🎥;
  an **Artifacts** board lists what the run pinned: role, fields with secrets as ●●●, "created in scene 2, step 4"
  linking to that step, a cropped still, cleanup status) and the video with captions, or the failure: summary, first
  cause, steps with "did you mean", `report.md`, the ARIA tree at the failure, every file. Re-validate / re-run / replay headed.
- **Tours**: validate, render or run any platform tour, per environment, with silent speech if wanted.
- **Platforms**: each environment shown as shared or own, and whether it can be reset (↺ reset environment: `aft reset`); 🧹 CLEAN UP (`aft cleanup --platform`) with the runs that left test data behind; `platform init`; per platform every definition file (platform, environments, login, tours,
  fragments, fixtures, mocks, and support files) to open, create from a schema-valid template and edit; `platform check`,
  `doctor --platform`, `login` (fresh / manual), `discover` per environment and role; the `{env:…}` credentials its files
  reference and whether each is set (names only: the UI never shows values); saved sign-ins.
- **Writing scenes** (the simple editor): under each narration, how long the voice speaks vs. how long the steps take
  (and the scene's length in the last video), with a warning when the steps outlast the voice; under each step, what its
  `{data.x}` values are (from the app, the environment and the script's fixtures; credential-like keys shown as ●●●);
  🖱 PICK FROM THE PAGE opens the app at the scene's page (`aft snapshot --screenshot`) and lists every name on it:
  pick one, then Click it / Type into it / Check it shows adds the step (⚡ KEEP A BROWSER OPEN starts `aft session`, so
  looks are fast and ▶ DO THE STEPS SO FAR can run the scene first with `aft try-step`); 📌 pin steps open an editor
  (name, kind, fields from the page, the page address or a fixed value, secret fields, cleanup). After GENERATE and on
  SAVE, a `goto` that starts with "/" and so leaves the app's address is flagged (GENERATE makes ones that repeat the
  base path relative).
- **Do / redo until here** (`aft stage`): ▶ DO UNTIL HERE on every scene (and ▶ on each step row, on hover) in the
  script editor and on a run's storyboard, ▶ SETUP ONLY at the top (and ▶ DO IT ALL on a script's page). A popover asks
  for the environment, the role to hand off as and "keep the data when I end"; the script runs without a video and
  leaves the app open in a browser at that point, with its test data in place. The **stage card** (top of the page)
  says where it stopped, the run tag, what it created (secrets ●●●) and what ending will undo, with ↗ OPEN (brings the
  browser to the front), ↻ REDO UNTIL HERE (undo, then do it again), ⇢ MOVE TO… (pick ▶ elsewhere), ■ END & CLEAN UP
  and ■ END, KEEP DATA; the point reached is outlined in the page. A failed stage shows what failed and links to its run
  (review, suggest a fix); the browser stays at the failure. The start page lists **Live stages**. From a run's page it
  stages the script that ran there.
- **Videos** (a run's page and a script's page): scene markers under the player, from `tour.vtt`; click one to jump there.
- **Compare** (⇄ on a run's page): the run next to an earlier run of the same script: result, time, video length,
  findings, each criterion, and every step that got better, worse, edited, added or removed.
- **Trash** (☰ menu): everything deleted (scripts, files, apps, runs), with ↩ restore when its old place is free.
- **Editor**: platform.json and environments.json open as a form built from their schema (Form / Raw tabs); Ctrl+S saves; JSON files get Format and "schema check" (`aft validate --schema-only`); tours also a dry
  run (`aft validate`) and a scene outline.
- **Jobs**: every command the UI started, with its live log, a Stop (Ctrl+C) button and the `--json` result.

The UI never imports the engine: it runs `aft … --json` (only validate, render, run, doctor, generate, platform,
login, session, snapshot, locate, try-step, export, import, suggest-fix, cleanup, reset, stage) and reads and writes files. It writes only `.env` (sign-in details, only names the platform references) and files under `platforms/<name>/`
(not dotfiles, auth state or node_modules) `out/**/tour.json` `out/.imports/`, and `out/.trash/` (delete moves things there; restore moves them back). Tests: `test/ui-server.test.mjs`.
