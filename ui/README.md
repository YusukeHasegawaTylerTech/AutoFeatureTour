# AutoFeatureTour UI

A local web UI over the files and the CLI. It opens on the script list, made for someone who has never used the tool:
every app with its scripts, a dashed **NEW SCRIPT** tile closing each app's row and **NEW APP** last; everything else
(runs, platforms, raw files, jobs, doctor) is in the ☰ menu.

```
npm run ui                                  # or: node ui/server.mjs [--port 4777] [--no-open] [--root <checkout>]
```

It opens the browser with a one-time token in the URL (kept as a cookie). The server listens on 127.0.0.1 only.

- **NEW SCRIPT** (per app) / **NEW APP** ( name, web address, how its sign-in page looks, test username/password,
  TEST THE CONNECTION), name the script, then write scenes: title, narration, and steps picked from six picture buttons
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
  ISSUE: LEAVE IT FAILING, ✔ GOOD ENOUGH / EXPECTED HERE, ↩ UNDO. Decisions are written into the tour that ran
  (`review.decisions`); the platform is never edited from here.
- **Runs**: every `out/<name>/<run>/run.json`; a run shows a **Scenes** storyboard (per scene: its still, title,
  narration, "open in the app ↗" for its URL, every step with ✔/✘, errors and "did you mean", ✏️ to that step in the
  editor; validation.md stays below, collapsed) and the video with captions, or the failure: summary, first
  cause, steps with "did you mean", `report.md`, the ARIA tree at the failure, every file. Re-validate / re-run / replay headed.
- **Tours**: validate, render or run any platform tour, per environment, with silent speech if wanted.
- **Platforms**: `platform init`; per platform every definition file (platform, environments, login, tours,
  fragments, fixtures, mocks, and support files) to open, create from a schema-valid template and edit; `platform check`,
  `doctor --platform`, `login` (fresh / manual), `discover` per environment and role; the `{env:…}` credentials its files
  reference and whether each is set (names only: the UI never shows values); saved sign-ins.
- **Editor**: Ctrl+S saves; JSON files get Format and "schema check" (`aft validate --schema-only`); tours also a dry
  run (`aft validate`) and a scene outline.
- **Jobs**: every command the UI started, with its live log, a Stop (Ctrl+C) button and the `--json` result.

The UI never imports the engine: it runs `aft … --json` (only validate, render, run, doctor, generate, platform,
login, session, snapshot, locate, try-step, export, import, suggest-fix) and reads and writes files. It writes only `.env` (sign-in details, only names the platform references) and files under `platforms/<name>/`
(not dotfiles, auth state or node_modules) `out/**/tour.json` and `out/.imports/`.
