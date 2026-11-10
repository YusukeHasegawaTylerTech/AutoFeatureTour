# AGENTS.md

Guide for AI coding agents (and humans) setting up, running and extending AutoFeatureTour. Keep it in step with
the CLI: `node src/cli.mjs --help` prints the authoritative usage (it's the comment block at the top of
`src/cli.mjs`).

## What it is

A CLI that makes narrated feature-tour videos of web apps. A user story (or a brief, or nothing but a URL) becomes
an editable script; the script is dry-run against the live app, then recorded with Playwright, paced to its spoken
narration, and post-processed into a video with captions.

```
story ─generate─► tour.json + script.md ─validate─► all steps resolve ─run─► recording ─► tour.mp4 + tour.vtt
```

Every command writes to its own folder, `out/<story-or-tour>/<YYYYMMDD-HHMMSS>-<id>/`, and never touches another run.

## Setup

```
install.cmd                                   # Windows, double-click; or: powershell -ExecutionPolicy Bypass -File install.ps1 -Link
node src/cli.mjs doctor                       # or `aft doctor` after -Link / npm link
```

`install.ps1` is idempotent: winget installs Node 22+ and ffmpeg if missing, `npm ci` when node_modules is out of
date, `npx playwright install chromium`, `npm link` with `-Link`, then `doctor`. Elsewhere: Node 22+, ffmpeg, then
`npm ci && npx playwright install chromium --with-deps`.

| doctor says | fix |
|---|---|
| Node.js 22+ missing | `winget install OpenJS.NodeJS.LTS` |
| ffmpeg / ffprobe missing | `winget install Gyan.FFmpeg`, then open a new terminal |
| npm packages / Playwright Chromium | `npm ci`, `npx playwright install chromium` |
| no SAPI voices (warn) | add a voice in Windows Settings > Speech, or run with `--speech silent` |
| claude CLI (warn) | only for `--llm claude`; install Claude Code |
| claude signed in (warn) | `claude auth login` (or run `claude` once); only for `--llm claude`, checked with `claude auth status` |
| platforms | informational: the platforms found, or none yet (`platforms/` is git-ignored, so a fresh clone has none: `aft platform init <name>`) |
| `<platform>: …` | that platform's own requirements; see `platforms/<name>/README.md` (`aft doctor --platform <name>` makes them required) |

## Running

```
aft validate platforms/todomvc/tours/track-and-filter.tour.json             # dry run: every step, no video → validation.md
aft render   platforms/todomvc/tours/track-and-filter.tour.json             # preview: narration over title cards, no browser
aft run      platforms/todomvc/tours/track-and-filter.tour.json             # record (the platform's default environment)
aft run      my.tour.json --target qa                                       # another environment of the tour's platform
aft run      my.tour.json --base-url http://localhost:3000/                 # a one-off URL (or BASE_URL=...)
aft run      my.tour.json --speech silent                        # headless/CI: silent audio, captions carry the narration
aft run      my.tour.json --voice zira --rate 1                  # another narrator for this run; aft voices lists them
aft all      --story story.md --platform todomvc --llm claude                # story → script → dry run → video
aft batch    platforms/todomvc/tours/ --reset --speech silent                # several tours in order, one reset first
aft ui                                                                       # the local web UI (ui/README.md); Ctrl+C stops it
start.cmd                                                                    # or `node start.mjs`: the UI in its own window, reusing a running server; a server it started stops when the last UI window closes
```

Add `--json` to any command for one JSON result on stdout (see "Agent primitives"). Exit codes: 0 ok · 1 usage/config · 2 SCRIPT failure · 3 app unreachable · 4 CRITERION failure · 5 APP error (see
"When a run fails"). Nothing prompts unless you ask (`login --manual`, `--headed --pause`).

Run folder contents: `tour.mp4` (the video), `tour.vtt` (captions), `recording.webm` (raw browser recording),
`clips/` (per scene), `scene-NN.wav` (narration), `timings.json` (scene windows in the recording), `screens/`
(a still per scene, discovery pages), `trace.zip` (Playwright trace), `tour.json` / `script.md` (generated
scripts), `validation.md`, `notes.md` (the platform's notes as they were when the run started, if it has any), `discovery.json`, `run.json` (command, args, status; a dry run with blocking steps is `failed`), `ledger.json` (what was set up and
undone), `artifacts.json` + `artifacts/` (what the run pinned), `slides/` (each slide scene's still), `source/` (the
tour as it ran, with its slide images, upload files and `pages` folder, so `aft run <run>/source/<tour>.json` renders
it again wherever the original was). On failure: `screens/failure.png`,
`trace-failed.zip`, `recording-failed.webm`. `out/<name>/latest.json` points at the newest successful run.

**Voices:** `aft voices` lists the installed narrators (Windows SAPI; Settings > Time & language > Speech adds more).
Which one speaks a scene, first match wins: the scene's `"voice"`, `--voice`, the tour's `"voice"`, the platform's
`"voice"`, the system default. Speaking rate (`-10` slow to `10` fast) follows the same order with `"rate"` /
`--rate`. Short names work (`"Zira"`, `"david"`; `aft voices --try zira` shows the match); a name that matches no
installed voice, or several, stops the run before anything is spoken, listing the installed ones. A per-scene voice
gives a second narrator (a dialogue, a quoted user). The UI's Tours page has voice and rate pickers for a run.

**Video trimming:** long waits (page loads and busy indicators, `waitFor`, `waitForResponse`, dismissed known issues)
are recorded in `timings.json` (`scenes[].waits`) and cut from the video, keeping a 0.3 s lead-in; the narration is
never cut. `"video": { "trimWaits": "cut" | "speed" | "off", "trimWaitsOver": 1.5, "speed": 4, "leadIn": 0.3 }` on the
platform or tour; `--no-trim` keeps the raw pacing for one run. report.json `trimmed` (and report.md "Video") says how
much each scene lost. Captions add "Simulated data" over scenes a mock answered in, and a short note when a tolerated
known issue is on screen.

**Git Bash:** it rewrites arguments that start with `/` (`--url "#/case/1"`, a try-step's JSON) into Windows paths
(`C:/Program Files/Git/case/1`). aft refuses such arguments; `export MSYS_NO_PATHCONV=1`, or use PowerShell.

## When a run fails

A tour video never silently shows an error: a failed run behaves like a failed test. Detection, classification and
reporting are deterministic (no LLM on the run path). Classes describe what was observed, not why.

| exit | class | observed |
|---|---|---|
| 0 | ok | every step and check passed; `tour.mp4` written |
| 1 | error | a usage or config problem, or an unexpected error in the tool |
| 2 | SCRIPT | an action step couldn't be performed: target not found, covered by another element, disabled, or detached; or the script isn't ready (unresolved or empty scenes) |
| 3 | UNREACHABLE | nothing answered at the app's URL |
| 4 | CRITERION | a `verify` ran and its check failed ("AC2 NOT MET") |
| 5 | APP | during a step the app showed its error UI (`"errors"`), returned an HTTP error or threw an uncaught exception (per `"appErrors"`), or a page didn't finish loading |
| 6 | LOGIN | signing in didn't reach a signed-in page (also: an expired session with no credentials to sign in again) |
| 7 | TOOLING | a local tool failed: ffmpeg, the voice, the browser, or the disk |
| 130 | INTERRUPTED | Ctrl+C or a kill signal; the partial report and bundle are written and marked incomplete |

Every run writes `report.json` (schema `aft-report/1`, written after each scene too, so a crash leaves it current) and
`report.md`, which starts with five lines: **what failed**, **why we think so** (the rule above), **first cause** (the
failing request or browser error during that step, e.g. `GET /internal/DynamicReports/Modules 500`, kept apart from
earlier unrelated ones), **look next**, **criteria so far**. Then the failing step, the warnings (ambiguous targets,
pages that never settled, app errors that didn't fail the step) and every step. Actions that time out are retried
(`"retries"`, default 1); checks never are. A failed run writes **no** `tour.mp4`. It keeps
`recording-failed.webm`, `screens/failure.png`, `trace-failed.zip` and a **triage bundle**:

```
<run>/triage/            (--zip: also <run>/triage.zip; "INCOMPLETE" present if the run was cut short)
  report.md / report.json   the same report; report.json "failing", "firstCause", "criteria", "steps"
  script.json               the script that ran, failing step marked "__FAILED__"
  page/aria.yml             accessibility snapshot at the failure · page/page.json (URL, title) · page/text.txt · page/dom.html
  screenshot.png            (PII mask applied) · login-failure.png for LOGIN failures
  console.json  network.json  every console error / failed request, with the step that was running ("stepKey")
  trace.zip                 Playwright trace (full network traffic, cookies, DOM: sensitive; "trace": false turns it off)
  PROMPT.md                 a brief for any AI assistant, about triaging the run
  notes.md                  the platform's notes at the start of the run (PROMPT.md includes them)
```

**App errors policy** (per target): `"appErrors": { "network": "fail"|"warn", "pageErrors": "fail"|"warn",
"console": "fail"|"warn", "ignore": ["<regex>"] }`. Default: warn (listed in the report, the step passes). Ignored
entries (known noisy endpoints or messages) stay in network.json/console.json marked `"ignored"`. `"errors"` names
the app's error UI (a selector plus text regex); it always fails the step.

### Known issues (workarounds)

A known app or environment issue (a service that isn't there locally, so a popup, an inline error panel, a toast or a
failing request) is declared once per platform as a **workaround**: what it looks like (`when`), what to do about it
(`do`), and how to report it (`as`). Tours don't need to mention it; when the issue isn't there, nothing happens. Mocking the
service instead would hide a real problem.

```json
"workarounds": [
  { "name": "TCM unavailable popup", "when": { "role": "dialog", "hasText": "/TCM|service unavailable/i" },
    "do": [ { "click": { "role": "button", "name": "OK" } } ], "as": "warn" },
  { "name": "TCM status panel", "when": { "css": ".error-panel", "hasText": "TCM" }, "do": "tolerate" },
  { "name": "TCM lookup 503", "when": { "request": "/api/tcm/", "status": "5xx" } }
]
```

- `when`: a locator, a failing request (`request` + `status`: 503, "5xx", a list; + `method`), or `{ "console": "/regex/" }`
  (console errors and uncaught exceptions); `paths` limits it to pages whose URL contains / matches one of them.
- `do`: steps that dismiss it (run off narration, scoped to the matched element unless `"scoped": false`; its UI must be
  gone afterwards unless `"noWaitAfter": true`; a failing one is a SCRIPT failure naming the workaround); `"tolerate"`
  (default: left on screen, it doesn't fail the step through `errors` / `appErrors`, and it still blocks a click it
  really covers); `"hide"` (CSS `display: none`: fakes the app's state, reported as such).
- `as`: `warn` (default: named in the warnings and report, the run passes), `fail` (APP, exit 5, first cause = the
  known issue: "this must not happen here"), `silent` (report.json only). `times`: at most n firings, then a normal error.
- **Per environment**: `environments.json` entries take `workarounds` too, merged by `name`: the same name refines the
  platform's rule for that environment (partial entries merge over it; `"off": true` disables it), a new name adds one
  there only. A `--base-url` one-off gets the platform's rules only. Typical: `"as": "fail"` in platform.json, `"as":
  "warn"` in `local` (see `platforms/rms`).
- **Per story**: a tour may list its own `workarounds` too, applied after the platform's and environment's (same name
  refines one, `"off": true` turns it off for that story; source `story`). Mark a real app issue being worked around
  for now with `"issue": { "note", "ticket" }`: the run then reads "passed with known issues" (see Review).
- Checked before every step, on each poll while a step looks for its target or waits on a check, after each step
  (before the error UI), and when a click finds its target covered; in runs, validate, sessions (try-step, snapshot),
  login and discovery. Stacked known dialogs are closed newest first. Playwright's `addLocatorHandler` isn't used: it
  only fires inside Playwright's own actionability checks, which the paced recorder bypasses.
- Reported in report.json `workarounds` (each firing: name, source `platform` | `env:<name>`, what matched, action, the
  step) and `workaroundRules`, report.md "Known issues", the warnings and PROMPT.md. Matched requests and messages stay in
  network.json / console.json marked `"workaround": "<name>"`.

### Review: true and false results

A run's outcome says what was observed; the **review** (`src/review.mjs`, in report.json and validation.json
`review`, and report.md "Review") says how far to trust it, and records the person's calls about it, per story:

- **Evidence per criterion** (fixed rules about how easily its checks could pass while the app is wrong):
  `strong` (a required check of a specific condition, text, value, count, state or URL, on a target found by its name,
  no mock or known issue in that scene) · `moderate` (only "it's visible", CSS targets, an ambiguous match, or a known
  issue fired there) · `weak` (only "hidden"/absent checks, only optional ones, a mock answered, or a known issue was
  hidden) · `none` (shown, not checked) · `failed`. Each has its reasons.
- **Findings**, each with a stable `id`: failures (`fail|scene|action|target`), weak or missing evidence, known issues
  that fired, mocks, and story workarounds / known-issue steps that no longer fire ("may be fixed").
- **Decisions** live in the tour: `"review": { "decisions": [ { "finding", "decision": "script" | "workaround" |
  "app-issue" | "accept", "note", "ticket" } ] }`. They never change how a run executes, only how its result reads.
- **A failing check that is a real app issue, for now**: `"knownIssue": { "note", "ticket" }` on the step. It still runs;
  failing is expected (the run carries on, the criterion reads "known issue"); passing says the issue looks fixed.
- **Verdict**: `passed` · `passed-with-issues` (a known issue worked around; never plain green) · `needs-review`
  (an undecided finding) · `failed` · `failed-app-issue` (every failure marked a real app issue). Exit codes are unchanged.
- **AI fix**: `aft suggest-fix <run> --finding "<id>" --llm claude` proposes a corrected step (the script is wrong), a
  story workaround (something unrelated got in the way), or says it's the app; it never edits the tour. It is told not
  to change a check's expected value to match what the app shows. The UI's review card (run page) offers all of this as
  buttons.

**Redaction:** every text file in the report and bundle has the tour's secret values (`"secret": true` steps and
credential-like env vars), auth headers, cookies, bearer tokens, JWTs and token-like URL parameters replaced with
`***`. Screenshots get the `mask` applied. The trace can't be scrubbed: set `"trace": false` for targets where
that matters.

**Your job as the agent: get the run to pass, or report a blocker.** SCRIPT: fix the step (the "did you mean"
matches and `triage/page/aria.yml` show the names on the page) and re-run. CRITERION, APP, UNREACHABLE: if the
step itself is wrong, fix it; otherwise stop and report the blocker (the failing step, what was observed: request and
status, error text, screenshot). App defects go to the app's owners with the bundle; finding their root cause is not
part of this job.

To replay by hand: `aft run <tour> --headed --pause` (stops at the failure with the Playwright inspector),
`--until-step N` (stop after step N, counted across the tour as in report.md; exit 0, no video), `--from-step N`
(steps before N run fast, unpaced).

## File types

Every definition file is JSON with a published schema (JSON Schema 2020-12, `schemas/`, versioned `…/v1/…` in
`$id`). **The schemas are authoritative**: the loader, `aft validate` and editors all check against the same files,
and where this guide and a schema disagree, the schema wins. Each file starts with `"$schema": "<relative path>"`, so
VS Code validates and autocompletes it with no setup (`.vscode/settings.json` also maps the file names).

| file | purpose | schema |
|---|---|---|
| `*.tour.json` | a tour: scenes of narration and steps (official suffix) | `schemas/tour.schema.json` |
| `platforms/<p>/platform.json` | how the app behaves everywhere | `schemas/platform.schema.json` |
| `platforms/<p>/environments.json` | where it runs (baseUrl, launch / attach) | `schemas/environments.schema.json` |
| `platforms/<p>/login.json` | sign-in steps per role | `schemas/login.schema.json` |
| `platforms/<p>/fragments/<f>.json` | reusable steps with parameters | `schemas/fragment.schema.json` |
| `platforms/<p>/fixtures/<f>.json` | test data, hooks, off-camera steps | `schemas/fixture.schema.json` |
| `platforms/<p>/mocks/<m>.json` | canned responses a tour opts into (`"mocks": ["<m>"]`) | `schemas/mocks.schema.json` |
| (shared) | locators and steps, used by all of the above | `schemas/common.schema.json` |

`aft schema [type] --json` prints a schema (with the shared definitions), so an agent can fetch the exact format.
`aft validate <file>` checks any definition file against its schema (a tour also gets a dry run; add `--schema-only`
to skip it). A file that doesn't match is a config error (exit 1) listing every problem by path:

```
error: my.tour.json doesn't match the tour schema (schemas/tour.schema.json):
  scenes[2].steps[0].click: unknown key "nmae" (a locator has role, name, exact, label, …)
  scenes[2].steps[1]: missing "text"
  scenes[3].steps[4].state: expected one of "visible", "hidden", "enabled", …
```

The schemas are generated from `src/schema-defs.mjs` (`npm run schemas`; a test fails if they're stale). YAML isn't
accepted yet; `.tour.json` is the format.

## Steps

One action key per step (the schema's `$defs/action_<name>` has every option, with descriptions).

| step | does | options |
|---|---|---|
| `{ "goto": "/path" }` | open a path under the environment's baseUrl; the URL already open is reloaded (a hash route wouldn't navigate, leaving old UI state) | `reload` (always load afresh after navigating) |
| `{ "click": L }` | move the cursor there and click | `button` (left/right/middle), `modifiers`, `clickCount`, `opensPopup` |
| `{ "dblclick": L }` / `{ "rightClick": L }` | double / right click | |
| `{ "hover": L }` / `{ "point": L }` | move the cursor (point: just to draw the eye) | |
| `{ "fill": L, "text": "…" }` | clear and type | `secret` |
| `{ "type": L, "text": "…" }` | type key by key, without clearing | `delay`, `secret` |
| `{ "clear": L }` / `{ "focus": L }` | empty a field / focus it | |
| `{ "press": "Enter" }` | a key or chord | `on`: an element to press it on |
| `{ "check": L }` / `{ "uncheck": L }` | checkbox, radio, switch | |
| `{ "select": L, "option": … }` | a `<select>` option: label/value, list, or `{ label \| value \| index }` | |
| `{ "upload": L, "files": "a.pdf" }` | file input or upload button (relative to the tour, then the platform's fixtures/) | |
| `{ "drag": L, "to": L }` | drag and drop with a visible cursor path | |
| `{ "scroll": 400 }` / `{ "scroll": L }` | wheel by pixels / bring an element into view | |
| `{ "waitFor": L }` | wait off pace | `state`: visible, hidden, attached, detached |
| `{ "verify": L }` | a check (CRITERION on failure); without a condition: visible. `text` / `exactText` compare the element's rendered text (innerText, whitespace collapsed, child elements included: `<strong>2</strong> items left` is "2 items left") or its source text, so a label CSS shows in capitals still matches as written ("Paused" for "PAUSED"); a check that fails only on case says so | `text` (contains or /regex/), `exactText`, `value`, `count` (visible matches), `state` (visible, hidden, enabled, disabled, checked, unchecked, selected, unselected, editable, focused; `selected` is aria-selected, for tabs and options; `checked` on a non-checkbox reads aria-selected / aria-checked / aria-pressed), `near` (`true` or n: compare the text of the element's parent / n-th parent, for a label and its value in separate elements) |
| `{ "verify": { "url": "…" } }` / `{ "verify": { "title": "…" } }` | the page's URL / title contains (or /regex/) | |
| `{ "capture": L, "as": "code" }` / `{ "capture": { "url": true }, "as": "u" }` | remember a value from the page (a generated id or code, a link) for later steps as `"{vars.code}"`: an element's attribute, else a field's value, else its text; or the page URL. Using a value that was never captured is a SCRIPT failure | `attribute` (e.g. `href`), `pattern` (regex: keeps its first group, or the whole match) |
| `{ "dialog": "accept" \| "dismiss" }` | how to answer the next alert/confirm/prompt (default accept) | `text` (prompt answer), `expect` (message; CRITERION if different) |
| `{ "signInAs": "<role>" }` | switch to another login role partway through, in the same browser: cookies and the page's storage cleared, the role's saved login loaded (every role a tour switches to is signed in off camera before the run), its `checkPath` opened until `signedIn` shows; later steps are reported with `"account"` | `url` (open this instead), `keepCookies` (domains to keep, e.g. another site) |
| `{ "switchTo": "main" \| "popup" \| "last" }` | continue on another tab (see `opensPopup`); only the main tab is filmed | |
| `{ "download": L }` | click and save the download to `<run>/downloads/` | `saveAs`, `expect` (file name; CRITERION if different) |
| `{ "waitForResponse": "/api/x" }` | wait for a response; better as an option on the step that triggers it | `status` (else APP), `method` |
| `{ "mock": "/api/x", "json": … }` | canned responses for the rest of the run; needs `"allowMocks": true` on the tour (refused for `"style": "verification"`), and every mock is in report.json `mocks`, the warnings and a "Simulated data" caption; reusable sets: `platforms/<p>/mocks/<name>.json`, `"mocks": ["<name>"]` on the tour | `status`, `body`, `contentType`, `method`, `times` |
| `{ "wait": 1.5 }` / `{ "at": 0.5 }` | pause seconds / wait until that fraction of the narration | |
| `{ "use": "frag", "with": {…} }` / `{ "code": "x.mjs", "with": {…} }` | a fragment / a code step (see Platforms) | |

`{ "pin": "name", "fields": {…} }` pins an artifact (see Fixtures). **Off camera**: `"camera": false` on a scene
means it runs and is checked (its criteria count) but has no narration, clip or caption. On a step, it runs unpaced and
its time is always cut from the video. Off-camera entries are marked `offCamera` in the report.

On any step: `optional`, `timeout`, `retries`, `criterion`, `comment`, `knownIssue` (see Review), `camera`, and `waitForResponse` + `status` + `method`
(listen before acting, so the response can't be missed). Steps that may already have had their effect (code, mock,
download, dialog, a waited-for response, a popup) are never retried. URL and text patterns are substrings, or
`/regex/flags`. A click whose target sits under a fixed or sticky header, footer or toolbar is scrolled to the middle
of the screen and tried again before it counts as blocked; a modal or full-page overlay still blocks it.

Values that change every run (a new record's id, a share code) go through `capture`; `{vars.<name>}` works in any
string of a later step, across scenes, and in code steps as `ctx.vars`:

```json
{ "capture": { "role": "strong", "within": { "label": "Line panel" } }, "as": "code" }
{ "fill": "Line code", "text": "{vars.code}" }
{ "capture": { "url": true }, "pattern": "/orders/(\\d+)", "as": "order" }
```

**Locators** (`L`): a string (tried as button/link/tab/… by exact name, label, placeholder, the same roles by partial
name, text, a `name=` attribute, a custom-element tag; `#`, `.`, `[` or `css=` mean CSS), or an object with exactly
one of `role` (+`name`), `label`, `placeholder`, `text`, `testId`, `alt`, `css` (+`exact`), narrowed by `has` /
`hasNot` (a locator inside it), `hasText` / `hasNotText`, `nth` (0-based: `"nth": 1` is the second match; `name`, `label`, `text`, `alt` and `hasText` also take `/regex/flags`, e.g. `{ "role": "tab", "name": "/^Review \(/" }` for a name with a count), and scoped by `within` (search inside the element
another locator finds; nest them to chain) and `frame` (iframe selector, or a list for nested frames):

```json
{ "click": { "role": "button", "name": "Edit", "within": { "role": "row", "hasText": "Beta" } } }
{ "verify": { "role": "row", "has": { "role": "button", "name": "Edit" } }, "count": 2 }
{ "click": { "role": "button", "name": "Pay", "frame": "iframe[title=checkout]" } }
```

## Platforms

**`platforms/` is local and git-ignored**: each machine keeps its own platforms, and none are committed (shared examples
may get their own home later). The `todomvc`, `rms` and `agenticfoia` examples below exist only where someone has
set them up; `aft platform init <name>` creates a new one.

A **platform** is everything about one app that isn't a particular tour. Tours name a platform and only describe
what to show; they never contain a base URL, credentials, launch commands or app-wide selectors (the loader refuses
those keys, and absolute URLs, in a platform tour). Platforms today: `todomvc` (the reference), `rms` (local NWPS
RMS), `agenticfoia` (code tours that build and start their own app). `aft platform list` shows them.

```
platforms/<name>/
  platform.json       how the app behaves everywhere: ready (busy indicators, stable page), errors (its error UI),
                      appErrors, ignore (noisy requests/messages, regex), mask, pronounce, viewport, voice,
                      ignoreHTTPSErrors, startPath, discover.paths, timeouts, retries, trace, video (trimming waits),
                      workarounds (known issues: see "Known issues")
  environments.json   where it runs: { "default": "local", "local": { "baseUrl", "launch" | "attach", "timeouts", "workarounds" }, "qa": {...} }
                      launch: start it if nothing answers (attaches if it's already up; "stop": false leaves it running);
                      if the command exits with an error before it answers, the run stops then (UNREACHABLE) and quotes its log;
                      past "timeoutSeconds" it keeps waiting (up to 3×) while the service's log is still growing
                      attach: [{ "name", "healthUrl" }]: never start anything; down = UNREACHABLE (exit 3)
  login.json          { "default": "<role>", "signedIn": "<css>", "checkPath", "maxAgeMinutes", "roles": { "<role>": { "steps": [...] } } }
                      credentials as "{data.username}" / "{data.password}" (or "{env:NAME}"); saved state: auth/<platform>/<env>/<role>.json (git-ignored)
  "data"              in platform.json and in each environment: values for {data.<key>} in login steps, fixtures and
                      tours, e.g. the account to sign in as; strings may be "{env:NAME}" (keep passwords in .env).
                      The more specific wins: platform < environment < the tour's fixtures. Another account:
                      another environment, a fixture, or a copy of the platform
  fragments/          reusable steps: <name>.json { "params": {...}, "steps": [...] } or <name>.mjs (a code step)
  fixtures/           test data: <name>.json { "data": {...}, "setup": [hooks], "teardown": [hooks], "steps": [...] }
  mocks/              opt-in canned responses: <name>.json { "mocks": [mock steps] }
  notes/              what was learned about the app: <name>.md (optional frontmatter "schema: aft-platform-notes/1");
                      findings are "### <ID> · <title>" + "- area/type/status/seen/evidence/suggested: …" lines;
                      notes/imported/<platform>/ holds notes that came with imported tours
  requirements.mjs    extra `aft doctor --platform <name>` checks       README.md   what it is, data rules
  tours/              its tours; smoke.tour.json is what `aft platform check` runs
```

A platform tour:

```json
{ "name": "clear-completed", "platform": "todomvc", "fixtures": ["three-tasks"],
  "story": { "id": "TODO-202", "acceptanceCriteria": ["…"] },
  "scenes": [ { "title": "…", "narration": "…", "url": "#/", "criteria": [1],
                "steps": [ { "use": "add-todo", "with": { "text": "{data.first}" } }, { "verify": { "text": "{data.first}" } } ] } ] }
```

Optional `"env"` and `"role"` pick an environment and a login role (todomvc has no login, so no role); they are defaults: `--target <env>` and `--role <name>` override them, and `--base-url` / `BASE_URL`
override the environment's URL. A tour without `platform` (with its own `baseUrl`, `login`, …) still works for
quick experiments and tests, but anything that will be kept belongs in a platform.

**Fragments** are called from any step list (scenes, login, fixtures, other fragments) as
`{ "use": "<name>", "with": { … } }`. A JSON fragment declares `params` (`{ "required": true }` or
`{ "default": v }`; an unknown or missing parameter is a config error) and uses `"{args.<p>}"` in its steps; a string
that is exactly `"{args.p}"` passes the value as is, so a target object can be a parameter. Extra keys on the call
(`"optional"`, `"timeout"`) apply to each of its steps. Fragments are expanded when the tour loads: reports show the
real steps, each with `"from": "<fragment>"`, and a failure says `(fragment <name>)`. Cycles are refused.

**Code steps** are fragments too: `fragments/<name>.mjs`, called with `{ "use": "<name>", "with": {…} }` or
`{ "code": "<name>.mjs", "with": {…} }`:

```js
// platforms/todomvc/fragments/todo-count.mjs
export default async function ({ page, context, args, ctx }) {
  const n = await page.getByTestId('todo-item').count();
  ctx.check(n === Number(args.count), `expected ${args.count} tasks, found ${n}`);   // CRITERION (exit 4) if false
}
```

`ctx`: `check(ok, msg)` (fails as CRITERION, for the step's `"criterion"` or the scene's criteria), `appError(msg)`
(APP), `resolve(target)` (the same target rules as JSON steps), `tour` (paced `click`, `typeInto`, `moveTo`),
`url(path)`, `baseUrl`, `timeouts`, `log`. Any other throw is a SCRIPT failure. Code steps must be deterministic (no
LLM, nothing random on screen) and are never retried. Use them for what steps can't say; a `.tour.mjs` code tour
(`export default { platform, name, script, async record(ctx) }`, with `ctx.platformDir`) remains the escape hatch for
a whole tour, like `platforms/agenticfoia/tours/`.

**Fixtures** hold the data a tour needs. `setup`/`teardown` hooks (`{ "run" }`, `{ "node" }`, `{ "http" }`; run from
`fixtures/` with `BASE_URL` and `RUN_DIR`) run before the browser starts and after it closes; `steps` run in the
signed-in browser off camera before the first scene. Their `data` is `"{data.<key>}"` in the tour's steps, so
narration-visible values live in one place. A setup hook can **look data up** instead of the tour hard-coding a record
id: `{ "run": "sqlcmd … -h -1 -Q \"SELECT TOP 1 Id …\"", "output": "text", "as": "caseId" }` (or `"output": "json"`, an
object merged into data; works for `node` and `http` hooks too) makes `{data.caseId}` available to steps and scene
`url`s at run time. A `{data.x}` that nothing provided is a SCRIPT failure.

**Repeatable runs.** Prefer paired **items** to the `setup`/`teardown` lists (which still work):
`"items": [{ "name", "check": hook, "setup": hook | [hooks], "teardown": hook | [hooks], "readOnly" }]`. Items run in
order and are undone in reverse, and only the ones that ran. A `check` that succeeds means the data is already there:
setup is skipped ("already in place") and nothing is undone. A check that still fails after setup is a SCRIPT failure
(`SETUP: …`). Browser data: `checkSteps` (all pass: `steps` skipped), `steps`, and `cleanupSteps`. Cleanup steps run off
camera after the last scene, in a page of their own, even when a scene failed. Everything is written to
`<run>/ledger.json` before it runs (pending → done → undone / undo-failed), so a crash or a kill leaves a record.
Ctrl+C runs the pending undo, with a 30 s limit. **`aft cleanup`** finishes it later:
`aft cleanup [<run>] [--platform p] [--target env] [--tag <prefix>] [--older-than 2d] [--all] [--dry-run]`. Without a
run, `--all`, `--platform` or `--tag` it only lists what is pending. Browser undo runs in a one-shot signed-in session.
The start of a run does this for earlier runs of the same tour. report.json `fixtures` (and report.md "Test data")
show each item. A failed undo is a review finding, `leftover|<item>`.

**Artifacts.** `{ "pin": "newOrder", "role": "order", "fields": { "id": { "capture": { "url": true }, "pattern":
"/orders/(\\d+)" }, "customer": "#customer", "code": { "value": "…" } }, "secret": ["code"], "cleanup": [steps] | hook }`
pins what the run just created. A field is a locator (its value or text), a capture spec, or `{ "value" }`. Later steps,
scenes, teardowns and cleanups use `{artifact.newOrder.id}`, or `{artifact[order].id}` for the latest of a role. An
unknown artifact or field is a SCRIPT failure. The cleanup joins the ledger the moment the pin is made. Secret fields
are `***` in every report and in `artifacts.json`. That file records each artifact's fields, where it was made, a
cropped still (`artifacts/<name>.png`) and its cleanup status. A setup hook with `"output"` can pin what it printed
(`"pin": "account", "role", "secret"`). The review suggests a pin (`pin?|scene|step`, with the step to add) when a
step's URL shows a new record id and nothing is pinned. `generate --llm` proposes pin steps. Nothing is pinned
automatically.

**Run tags and shared environments.** `{run.tag}` (`aft-MMDD-<run id>`, also `RUN_TAG` for hooks) works in any string.
Tag what a tour creates, so parallel runs don't collide and `aft cleanup --tag aft-1105` finds them. `"shared": true` on
an environment (QA): `validate` and runs warn about fixture items, fixture steps or pins that create data without
`{run.tag}` (mark lookups `"readOnly"`). `"reset": [hooks]` on a local environment restores a known state. It runs with
`aft reset --platform p [--target env]`, `--reset` on run/validate, or once at the start of a batch, and is refused on a shared environment.

**Batches.** `aft batch <tour.json | folder | glob>... [--target env] [--reset] [--validate-only] [--stop-on-fail]` runs
several tours in order, each through the normal `aft run` (or `aft validate` with `--validate-only`) in its own run
folder; other flags (`--speech`, `--no-trim`…) are passed on. With `--reset`, every tour must be on one platform and
environment (else exit 1), and the reset runs once before the first tour. The batch writes
`out/batch/<YYYYMMDD-HHMMSS>-<id>/batch.json` (schema `aft-batch/1`: each tour's run folder, exit code, class, verdict
and status passed | failed | interrupted | skipped) and `batch.md`. Exit code: 0 if every tour passed, else the first
failure's. `--stop-on-fail` skips the rest after a failure; Ctrl+C stops the current tour (exit 130) and marks the rest
skipped.

### Lifecycle

What happens when, and whether it can be skipped:

| when | what | skippable? |
|---|---|---|
| once per machine | `install.cmd` / `install.ps1`, then `aft doctor` | mandatory (doctor is idempotent; re-run after changes) |
| once per platform | `aft platform init <name>`, platform.json, environments.json, login.json, requirements.mjs, a smoke tour | mandatory |
| per environment | `aft platform check <name> --target <env>` | mandatory before the first real tour there; re-run when the app or environment changes |
| per env + role, until it expires | sign-in → `auth/<platform>/<env>/<role>.json` (`aft login`, or automatically on the first run) | skipped while the saved state works; renewed automatically on expiry when login steps and credentials exist; `--fresh-login` forces it |
| per session (one command) | launch or attach to the app; browser start | attach is skipped if the app is up; launch never restarts a running service |
| per run | earlier runs' pending undo → fixture items (check → setup) → browser → session check → fixture steps (off camera) → scenes → browser cleanup → hook undo (reverse) | fixtures only if the tour lists them; only what ran is undone; ledger.json throughout |
| per stage (`aft stage`) | the run's pipeline up to the point, unrecorded → hand-off (headed browser, data in place) → `stage end`: browser undo, hook undo (reverse), services stopped | `--keep` / End, keep data leaves the ledger pending (`aft cleanup <run>` later); one stage per tour + env, `--redo` replaces it |
| per step | the action, settle (`ready`), the app's error UI and `appErrors` policy, rule-based retry (actions only) | `"optional": true` steps may fail without failing the run; checks never |

### Onboarding a platform

```
aft platform init myapp --base-url http://localhost:3000/   # scaffold platforms/myapp/ (never overwrites); --no-login: no login.json
#  if the app answers at --base-url, the smoke tour checks its start page's heading and title; else any heading
aft doctor --platform myapp                                 # machine + requirements.mjs
#  edit environments.json (baseUrl, launch or attach) and login.json (roles, {env:…} credentials in .env)
aft login --platform myapp [--target local] [--role user]   # or --manual for SSO/MFA
aft platform discover myapp                                 # screens, names and fields as that role sees them → discovery.json
#  write fragments/ for repeated flows (sign-in, open a record, search); fixtures/ for the data tours need
#  set ready / errors / ignore in platform.json from what discovery and the smoke run show
aft platform check myapp [--target qa]                      # doctor → settings → reachable → smoke tour (signs in, every step)
```

`aft platform check` passing in an environment means the platform is ready there. It stops at the first failing
stage; a failing smoke tour exits with its own class (LOGIN 6, UNREACHABLE 3, SCRIPT 2…).

## Agent primitives and the iteration loop

The tool doesn't decide anything; it answers questions about the run and the page. Every command takes `--json`:
stdout is then exactly one JSON document and every log line goes to stderr.

```json
{ "schema": "aft-cli/1", "command": "run", "ok": false, "exitCode": 2, "class": "script",
  "runDir": "…/out/todomvc/20261104-125141-5xma", "report": "…/report.json",
  "error": { "message": "SCRIPT failure: scene-02 step 3 …: Target not found: \"Svae\" (did you mean \"Save\"?)" }, "data": null }
```

`ok`, `exitCode` and `class` follow the exit-code table above; `data` is the command's result (`validate`:
`{ steps, failed, blocking, report }`; `run`: `{ video, seconds }`; `doctor`: `{ ok, checks }`; `platform list`:
`{ platforms }`…) and is kept on failure when there is one (a failing `validate` still returns its table).
Nested documents have their own `schema`: `aft-snapshot/1`, `aft-locate/1`, `aft-try-step/1`, `aft-session/1`,
`aft-doctor/1`, `aft-report/1`.

| command | answers |
|---|---|
| `aft session start --platform <p> [--target <env>] [--role <r>]` | opens a warm, signed-in browser (launching or attaching to the app as a run does) and keeps it; `status`, `stop` (stops only what it started; `--all`) |
| `aft snapshot [--url <path>] [--screenshot]` | `{ url, title, aria, text }`: the ARIA tree is the names steps can target |
| `aft locate "<target>"` | `{ resolved, strategy, uses, ambiguous, matches[], strategies[], alternatives[] }`: what a step with this target would act on, without acting |
| `aft try-step '<step or [steps]>' [--url <path>]` | performs them live (fragments and code steps too) and returns each step's report entry, network/console errors during them and the ARIA tree after; exit code = the class |
| `aft session wait [<call id>] [--session <name>] [--timeout <s>]` | waits for a session (or stage) call the CLI stopped waiting for, by id (none: the running one, else the last finished) and prints that call's own result document and exit code/class; `--timeout` running out: exit 1, `data.running: true` |

They use the running session (`--session <name>`, where the name is `<platform>-<env>-<role or anon>` and is in `session start`'s output, or the only one for `--platform`); without one they open a one-shot
browser for that call (slower: start, sign in, close). A session is one page: state carries over between calls, and
calls run one at a time: a second call while one is running is refused (busy) rather than interleaved. try-step and
snapshot handle known issues (workarounds) as a run does and list them under `workarounds`.

Every snapshot, locate and try-step call on a session has a call id (`callId` in its result). A long call outlives the
CLI's wait (a long try-step batch: "fetch failed", or `AFT_CALL_TIMEOUT=<s>`) without stopping: the CLI exits 1 with
`data: { callId, running: true, hint }`, and `aft session wait <callId> --session <name> --json` returns the call's
normal result when it finishes (the last 10 results are kept, so this works after it finished too). A busy refusal names
the running call. Stages answer the same way (`--session stage-<tour>-<env>`).

The loop, for writing or fixing a tour:

```
aft session start --platform todomvc --json                      # once; data: { name: "todomvc-demo-anon", status: "ready", url, port, services }
aft snapshot --url "#/" --json                                   # read data.aria for the real names
aft locate "What needs to be done?" --json                       # {"resolved": true, "strategy": {"role": "textbox", "name": …}}
aft try-step '{"use": "add-todo", "with": {"text": "Buy milk"}}' --json
aft try-step '{"verify": {"text": "Buy milk"}}' --json             # {"ok": true, …}; on false: data.steps[n].suggestions
#  … write the steps that worked into the tour …
aft validate <tour.json> --json                                  # every step, in its own fresh browser (never a session)
aft run <tour.json> --json                                       # the video; on failure read data / report.json / triage/
aft session stop
```

`try-step` output (shortened):

```json
{ "schema": "aft-try-step/1", "ok": false, "class": "script", "error": "SCRIPT failure: try-step step 1 {\"click\":\"Svae\"}: Target not found: \"Svae\" (did you mean \"Save\"?)",
  "steps": [ { "step": 1, "action": "click", "ok": false, "failure": "script", "error": "Target not found: \"Svae\"", "suggestions": ["Save"] } ],
  "network": [], "console": [], "after": { "url": "http://localhost:3000/ok", "title": "OK", "aria": "- heading \"Fixture\" [level=1]\n- textbox \"Name\"\n- button \"Save\"" } }
```

`try-step` really performs the steps (it can change data, like `validate`). Sessions write `<tool>/.sessions/<name>.json`
(git-ignored; it holds the local control token) and log to `out/sessions/<name>/<run>/session.log`.

### Staging: do / redo until here

A person reviewing a tour wants the app *live* at a point of it (after setup, after scene 2, after a step): the
story's records created, signed in as the right role, then test by hand from there. `aft stage` runs the tour's
pipeline without recording (no video, TTS or trace; every step unpaced) up to that point, and leaves the browser open
(headed), the services running and the data in place. Checks still run, so a broken state fails loudly (same classes
and report as a run; the browser stays open at the failure).

```
aft stage <tour.json | run folder> [--target env] [--as role] [--until-scene N [--step J] | --until-step N | --setup-only] [--keep] [--redo [--force]] [--headless] --json
aft stage list --json
aft stage end <name> [--keep] --json
```

- Points: `--setup-only` (fixtures and fixture steps, no scene), `--until-scene N` (scenes 1..N), `--until-scene N --step J`
  (scene N up to its script step J; a fragment counts as one, as in the editor), `--until-step N` (steps counted across
  the tour, as for `run`); none: the whole tour. A run folder stages the script that ran there (its `tour.json`, else the
  tour file in run.json), on that run's environment unless `--target`.
- One stage per tour and environment, named `stage-<tour>-<env>`: a second `aft stage` is refused; `--redo` ends the
  current one (undoing its data, newest first) and stages again with a new run tag. If that undo fails, `--redo` stops
  unless `--force` (the leftover stays in the old ledger for `aft cleanup`).
- `--as <role>` (or the tour's `"stage": { "role" }`) hands off in a second window signed in with that role's saved
  login (`aft login --role <r>` first). `"stage": { "note" }` is shown on the UI's stage card (what to try).
- The undo is deferred: ledger.json items stay `done` with `"stage": { "live": true }`; runs of the same tour don't undo a
  live stage's data (or one ended with `--keep`, `"kept": true`), only `stage end` or an explicit `aft cleanup <run>` does.
  `--keep` on a shared environment needs tagged data (`{run.tag}`).
- A stage is a detached process (`src/stage-daemon.mjs`, log `<run>/stage.log`) with a session's control port:
  `aft snapshot` / `locate` / `try-step --session stage-<tour>-<env>` work on it (it's only used when named).
- Run folder: run.json (`"command": "stage"`, status staging → staged | failed → ended), report.json, ledger.json,
  artifacts.json, `screens/stage.png`; `latest.json` is never touched. `aft stage list` and the UI's `GET /api/stages`
  read `.sessions/stage-*.json` (never the control token).

## Story to video (for agents)

1. Save the story as a file (id like `RMS-6142`, title, description, `Acceptance criteria:` list); see
   `examples/stories/`.
2. `aft generate --story story.md --platform <name> [--target <env>] --llm claude [--style verification|demo|training]`
   (the tour it writes names the platform). Without
   `--llm` you get a per-criterion draft to fill in by hand. The style is a generation hint only. With a platform, `--llm claude` also sends the
   platform's notes (accounts, setup recipes, findings) as context.
3. Review and edit the run folder's `tour.json`:
   - one scene per acceptance criterion (`"criteria": [n]`), narration saying which criterion it shows;
   - targets as visible names: `{ "role": "button", "name": "Run report" }`, `{ "label": "Hate Bias Status" }`,
     `{ "text": "Case Detail" }`; CSS only as a last resort. `npx playwright codegen <url>` shows the role/name;
   - `verify` for whatever a criterion requires to be visible; no destructive actions unless the story needs them;
   - anything listed under `unresolved` needs a person or a discovery of the right screen.
4. `aft validate <run>/tour.json`; fix each ✘ in `validation.md` (it suggests the closest names on the page), repeat.
5. `aft run <run>/tour.json` (records into a new run folder). On failure, read `triage/report.md`: SCRIPT means fix
   the step (match a name from `triage/page/aria.yml`); CRITERION or APP means the app, so report it, don't edit the
   check away.
6. Example: [platforms/rms/tours/RMS-6142.tour.json](platforms/rms/tours/RMS-6142.tour.json) (generated, then corrected by hand).
7. Flows you write twice become fragments; data the story needs becomes a fixture (see Platforms).

### Generate as a conversation

Instead of one shot, `--converse` makes generating a conversation: the agent explores the live app (on a stage of the
platform, `stage-conv-…`), writes steps it has tried, and comes back with questions; you answer, record steps by hand,
or ask for changes, and it picks up there. The run folder holds it all: `conversation.json` (schema
`aft-conversation/1`, `schemas/conversation.schema.json`: turns, questions, answers, per-scene state planned |
explored | recorded | verified), `tour.json` (the draft, always a valid tour: unfinished work is in scene `todo`
and `unresolved`, which block recording), `stages/` (the stage runs; their ledgers hold what probing created).

```
aft generate --story story.md --platform todomvc --llm claude --converse --json   # data.state: waiting, data.questions
aft converse <run> --answer q1=Approve --answer q2=yes --json                      # or --say "scene 3 is too long"
aft converse <run> --record 2 [--after-step 1]     # do scene 2 by hand in the stage's browser…
aft converse <run> --steps [--drop-last]           # …the steps so far…
aft converse <run> --stop                          # …then the agent narrates them and proposes checks
aft converse <run> --accept p1 | --reject p1       # proposals (a story workaround, a review decision) apply only if accepted
aft converse <run> --finish [--force]              # validate the draft; all scenes pass: final tour.json, stage ended (data undone)
aft converse <run> --end [--keep]                  # stop without finishing
```

- Waiting on the person is **exit 0** with `data.state: "waiting"` (and `data.questions`, each `{ id, type, text,
  options }`); the agent having nothing left is `"done"` (then `--finish`); `--finish` sets `data.finished`.
  Failures keep their exit codes. Question types: choose-target, criterion-ambiguous, missing-data, role, blocked,
  confirm-destructive, record-this, free-text.
- The engine drives Claude (`claude -p`, no tools, a JSON schema; the session is resumed each turn): it can only ask
  for probes (snapshot, locate, try-step, stage-to a point), and each turn has a probe budget. Steps that look
  destructive (delete, remove…) are refused until a confirm-destructive question is answered yes. A step it didn't try
  stays marked "not tried" in the scene's todo; `--finish` is the real gate (`aft validate`). Checks are never weakened
  to match what the app shows.
- Not on a production environment (an env named prod/production/live is refused): probing does real actions, like
  validate. On a shared environment the agent is told to tag data with `{run.tag}` and pin what it creates.
- Recording also works on a session started with `aft session start --headed` (daemon ops `record-start`,
  `record-steps`, `record-stop`; src/capture.mjs): password fields become `"secret": true` steps with `{data.<name>}`,
  never the value.

### Dev to QA: export and import

A tour is best written where the code and the data are (a dev's local platform), then run where the change is
deployed (QA). The two are separate platforms of the same app (QA's: a copy with its own environments, account and
known-issue policy).

```
aft export platforms/rms-local-dev/tours/RMS-6399.tour.json   # or a run folder: out/RMS-6399/<run>
#  → out/RMS-6399/<run>/RMS-6399.aft.json: send it to QA
aft import RMS-6399.aft.json --platform rms-qa                # → platforms/rms-qa/tours/RMS-6399.tour.json (--name, --force)
aft validate platforms/rms-qa/tours/RMS-6399.tour.json        # then aft run
```

The export (`"schema": "aft-export/1"`) is one file: the tour with its fragments inlined (each step's `comment` says
which fragment it came from, so the target's fragments can't change what was checked), code steps and upload files
embedded, and `source`: platform, environment and the dev's last result for it (run or validate, PASSED/FAILED, each
criterion). It holds no URLs, credentials or platform settings; the target platform supplies them. Fixtures and mock
sets travel by name (data lookups differ per environment): import lists any the target doesn't have, and `{data.x}`
stays for its fixtures to fill. Import never overwrites a tour unless `--force`. If the tour fails on QA where it
passed on dev, the report says what differs: a SCRIPT failure is usually a label that differs between versions
(fix the step, or match it more loosely); CRITERION or APP is what the deployed version does, so report it.

The export also carries the source platform's notes (`notes`: each file with its frontmatter, findings and text; notes
it had itself imported are left out). Import writes them to `platforms/<target>/notes/imported/<source-platform>/`, never
over the target's own notes (an earlier imported copy is kept unless `--force`), and lists the finding ids the target's
own notes don't have yet.

## Explainers: slides, pages and scratch tours

Not every video is a tour of an app: findings, a spike write-up, a design review, release notes. A scene with
**`"slide"`** instead of steps is a still drawn by a headless browser (no app, login or network) and narrated like any
scene. Slides are designed by hand in the tour file (the schema describes every field):

- `kicker` (a small label above), `heading` (default: the scene title), `subtitle`;
- content blocks, **drawn in the order they are written**: `body` (paragraphs), `bullets`, `code`, `table`
  (`{ head, rows }`), `columns` (side-by-side cards `{ heading, body, bullets, tone }`), `stats` (big numbers
  `{ value, label, tone }`, shrunk to fit their tile), `flow` (boxes left to right; write `"+"`, `"="`, `"&"`, `"or"`
  or `"vs"` as an item between two boxes for that connector, else an arrow), `callout` (the takeaway, in a coloured
  box), `image` (beside the rest when written last); comments in `code` (`// …`, `# …`) are dimmed;
- `note`: small print in the footer (a source, a date), never a takeaway;
- tones `ok` / `warn` / `bad` / `info` on bullets, cells, whole rows (`{ "cells", "tone" }`), cards, stats, flow
  boxes and callouts, as `{ "text", "tone" }` or a leading (or trailing) ✓ △ ✗ ℹ;
- `reveal`: the slide builds in, each bullet, row, card (then each bullet in it), stat or box in turn: `true` (one per
  narration sentence) or fractions of the narration (`[0, 0.3, 0.6]`); `"dim": true` fades the earlier ones;
- `theme`, `accent` per slide; `"slides": { "theme", "accent", "footer" }` on the tour, or in platform.json for a
  team's look (the tour's win). Text accepts `**bold**`, `*italic*` and `` `code` ``;
- **shared slides**: `"slide": { "use": "closing" }` takes `platforms/<p>/slides/closing.json`, else
  `slides/closing.json` beside the tour, or a `.json` path (`{ "title", "narration", "slide" }` or a slide alone); the
  slide's other keys and the scene's narration win. A run's `source/` copy has it filled in;
- on the scene: `"hold": 2` keeps it on screen 2 s after its narration, instead of the default pause (0.75 s,
  `--tail`); a shared-slide scene needs no `title` (the shared file's, else its name).

A tour of slides only needs no platform or baseUrl; `render` and `run` both make the video. `aft render <tour>
--slides-only` draws the slides in seconds (no voice, no video) with `slides/index.html`, the whole deck on one page,
for a fast layout loop. `validate` draws them too, and warns when content doesn't fit, when a footer note wraps, and when
a narration has what a voice misreads ("13K", ticket ids, symbols, "a/b", parentheses, "e.g."; add `pronounce`
entries or write it as said). Ranges ("60–80") and arrows ("→") are said as "to". Slides can sit between recorded scenes
of a platform tour (a title, a summary, context before a demo): only the recorded scenes use the browser. `"style":
"explainer"` turns off the review (there are no criteria to weigh).

**From a document, no AI:** `generate --from` / `scratch --from` turn markdown into slides. The first heading is the
title slide; each section is a slide. Lists become bullets, tables become tables, `>` quotes become callouts, prose
becomes body and code blocks become code, in document order. Write each slide's spoken words in the document, under its heading, as
`Say: …` lines (or `<!-- say: … -->`). They are the narration and never appear on the slide. Without them, the narration is the
section's text and the generated tour's comment says so. A heading "Topic: claim" (the first one too) becomes
kicker "Topic" and heading "Claim" (capitalised; the scene title is the topic, "Overview" for the title slide). A list
whose every item is `**Label:** text` (2 to 4) becomes `columns`, and one whose every item starts with a bold number
(`**80 MB** a day`) becomes `stats`. A paragraph like `Rules + Form → Decision ✓` becomes a `flow`. A ✓ △ ✗ ℹ at
the start or end of a bullet, cell, card text, stat or quote sets its tone (in a table, the whole row's) and is taken
off the text (the colour says it). `Layout: bullets` keeps a `**Label:**` or bold-number list as bullets.
`![caption](shot.png)` is an image with its caption. A ```` ```chart ```` block is a bar chart: `label | value` lines
(a unit after the number, or `unit: ms`; a currency sign before it, `$6.77`, or `unit: $`, is shown before the number; a third column or a glyph for the tone; `max: 100` for the scale). A
```` ```steps ```` block makes the section a **recorded scene** instead of a slide, on the platform's app or the
deck's `pages`: one step per line, JSON or shorthand (`goto index.html`, `click Review with AI`, `fill Request text:
…`, `select Status: Open`, `check`, `hover`, `press Enter`, `wait 1`, `verify Saved`, `verify url /done`), with
`Url: <path>` to open first. `reveal: auto` builds in any slide with two or more blocks, or one block of two or more
items (bullets, cards, stats, flow boxes, table rows, chart bars).

The markdown can be the whole design, so the tour never needs editing:

```
---
footer: RMS-4923 · spike/foia-request-validation
theme: dark                      # accent, voice, name, max-scenes too
reveal: auto                     # build in (see above), or: dim, off
pronounce: FOIA=Foya, RMS=R M S
pages: pages                     # static pages for ```steps scenes (relative to the document); or platform:, env:, role:
---
# RMS-4923 · Records Requests: Research on context limits

## Agents: they don't retain the rules
- **Misconception:** an agent holds the rules ✗
- **Reality:** instructions go to the model every run ✓
> △ One agent per agency still helps usage tracking.
Say: Agents don't save tokens.
Reveal: dim                      # per slide: yes | dim | no | 0, 0.3, 0.6
Hold: 2
Note: Measured on the spike branch
                                 # also: Use: closing (a shared slide), Theme: light, Accent: #c53030,
                                 # Voice: David, Rate: -2 (this section's narrator; voice:/rate: in front matter for all)
```

Edited the tour by hand anyway? `aft scratch <name> --from doc.md --update` regenerates from the document and keeps
every field changed since the last generation (`.generated.json` beside the tour records it, with the section each scene came from: scenes pair by section, so renamed titles or an inserted section do not shift edits onto the wrong scene), and lists what it kept; a merge that would make an invalid tour is refused and nothing is written;
scenes added by hand stay where they were. Each `--from` (and `--update`) copies the document's images, `pages:` folder and shared slides (`slides/` beside it) again. `--force` starts over. Short titles that repeat ("Foundry: …" five times) become the whole heading. No section is left out unless `--max-scenes` (or
`max-scenes:`) says so, and then it warns.

```
aft scratch foia-findings --from findings.md     # in scratch/foia-findings/ (git-ignored, kept, "$schema" works)
aft scratch demo                                 # a starter deck: one slide per layout, to copy from
aft scratch demo --pages                         # plus scratch/demo/pages/index.html, recorded in the browser
aft scratch demo-v2 --from-tour demo             # a new version of a deck (its folder copied: assets, shared slides, pages)
aft render scratch/demo/demo.tour.json --slides-only   # the deck as pictures: slides/index.html
aft generate --from findings.md [--llm claude]   # the same into a run folder (Claude: sends the document)
aft scratch                                      # the list
```

A tour with a `story` id names its run folder `<id>-<name>`: add the story before the first run, or `latest.json` and
`runs.jsonl` start again under the new name.

**`"pages": "<folder>"`** (stand-alone tours only) serves the tour's own static pages on a free local port for each run,
as its baseUrl: `goto` paths and scene `url`s are files in it (`"index.html?s=2"`), and steps and checks work on them as
on an app. Use it for content slides can't hold (a mock-up, a diagram with a cursor); use slides for the rest.

**Where one-off tours go:** `scratch/<name>/`, never a temp folder: a temp folder goes when the session does, and the
run's `source/` copy is the only way back. Outside the checkout, `aft schema tour --write <folder>` writes
`<folder>/.aft-schemas/` and prints the `"$schema"` to use. `aft export` embeds slide images; a tour with `pages` is
stand-alone and can't be imported into a platform (share its run's `source/` folder).

## Rules

- **Synthetic or test data only.** Local or dedicated QA/test environments are fine; never production or real
  records. `validate` performs the steps for real, so it changes data like a run does.
- **The engine is app-agnostic.** Nothing in `src/` may know about a particular app; app specifics live only in
  `platforms/<name>/`. Tours hold no URLs, credentials, launch commands or app-wide selectors.
- **Never overwrite a previous run.** Use `newRunDir`; no fixed output paths, no shared temp files, free ports.
- **Rendering never depends on an LLM.** LLMs may write scripts; scripts are files a person can review.
- `--llm claude` sends the discovery inventory, story text and the platform's notes to Claude; with `--converse` it also sends the live
  page's ARIA tree, text and errors from the probes (masked and redacted as reports are). Only use it where that's allowed.
- Never commit `out/`, `auth/`, `.sessions/` or `.env`.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| `ffmpeg not found` | install it (see Setup) and open a new terminal |
| `The sapi speech provider needs Windows` / no voices | `--speech silent` |
| `SCRIPT failure … Target not found` (exit 2) | the name differs on the page; see the "did you mean" suggestion, or `aft validate` for all of them; check with `npx playwright codegen <url>` |
| `CRITERION … not met` (exit 4) | the page didn't show what the check expects; if it's just slow, raise `timeouts.verify`; else report it |
| `APP error` (exit 5) | the report's "first cause" names the failing request or error during that step; report it as a blocker |
| `saved login expired; signed in again` | normal: an expired session is renewed automatically, off camera, when the tour has login steps and its credentials are set. `--fresh-login` forces it; `login.maxAgeMinutes` renews old sessions early |
| `LOGIN: … can't sign in by itself` (exit 6) | set the credentials it names, or (SSO/MFA, no login steps) run `aft login --platform <name> --manual` |
| exit 3, `didn't come up` / `attach-only` | app not running at the environment's `baseUrl`, or `launch.healthUrl` wrong; see `<service>.log` |
| exit 3, `<service> exited with code N before it answered` | the launch command crashed (the error quotes the end of its log): fix the app's startup (config, database), or the command |
| `action blocked: the element is covered by <…>` | a dialog, overlay or spinner is over it: close or wait for it first (a fixed header/footer is handled by itself) |
| `"baseUrl" belongs in the platform` | move it (and login, launch, ready, errors…) to `platforms/<name>/`; the tour keeps `platform`, `env`, `role`, `fixtures`, scenes |
| `Fragment "x" needs "with"` / `no parameter` | match the fragment's `params` |
| `known issue "…"` in the warnings | a platform workaround fired: expected in that environment; `"as": "fail"` there makes it a blocker |
| `workaround "…" step N … failed` / `its UI is still visible` (exit 2) | the workaround's own steps are wrong for that UI; fix them in platform.json (they're scoped to the matched element) |
| `didn't come up (… is still starting …)` | a slow service (a dev server compiling): raise the launch's `timeoutSeconds` |
| `looks like a path Git Bash rewrote` | `export MSYS_NO_PATHCONV=1`, or run from PowerShell |
| `session … is busy` | another call is still running on that session; wait, or start a second one with `--session <name>` |
| `stopped waiting for the try-step call c-…` | the call is still running on the session: `aft session wait <id> --session <name>` |
| scene overruns its narration | a step waited for its timeout; mark it `"optional": true` (3 s limit) or fix the target |

Reading a trace: `npx playwright show-trace out/<name>/<run>/trace-failed.zip` shows every action with DOM
snapshots, the console and network; find the last red action.

## Code map

`src/cli.mjs` commands and run folders · `exchange.mjs` export/import between platforms · `schema-defs.mjs` the schemas' source, `schema.mjs` validation and messages · `steps.mjs` step runner, locators, suggestions, code steps · `declarative.mjs`
tour.json → a run (platform composition, launch/attach, login, hooks, fixtures) · `platform.mjs` platforms, fragments,
fixtures, init · `platform-cli.mjs` `aft platform` · `session.mjs` / `session-daemon.mjs` sessions, snapshot, locate,
try-step · `stage.mjs` / `stage-daemon.mjs` do / redo until here · `cli-app.mjs` the app a command targets · `recorder.mjs` Tour (paced recording, cursor, trace, mask) · `discover.mjs` crawl ·
`plan.mjs` heuristic and Claude planners, stories · `converse.mjs` generate as a conversation · `capture.mjs` recording by hand ·
`narrate-timing.mjs` scene timing · `render.mjs` ffmpeg · `slides.mjs` slide scenes, pages, document outlines · `tts.mjs` speech · `auth.mjs` saved logins ·
`doctor.mjs` checks · `workarounds.mjs` known issues (merge, checkpoint, matching) · `review.mjs` evidence, findings,
decisions, verdict · `fix.mjs` AI fix proposals (`suggest-fix`) · `ledger.mjs` ledger.json, run tags · `fixtures.mjs`
hooks, fixture items, browser fixtures, artifacts, `aft cleanup` / `aft reset` · `batch.mjs` `aft batch` · `notes.mjs` platform notes · `daemon-calls.mjs` call ids, kept results. Tests: `npm test`.
