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
| `<platform>: …` | that platform's own requirements; see `platforms/<name>/README.md` (`aft doctor --platform <name>` makes them required) |

## Running

```
aft validate platforms/todomvc/tours/track-and-filter.tour.json             # dry run: every step, no video → validation.md
aft render   platforms/todomvc/tours/track-and-filter.tour.json             # preview: narration over title cards, no browser
aft run      platforms/todomvc/tours/track-and-filter.tour.json             # record (the platform's default environment)
aft run      my.tour.json --target qa                                       # another environment of the tour's platform
aft run      my.tour.json --base-url http://localhost:3000/                 # a one-off URL (or BASE_URL=...)
aft run      my.tour.json --speech silent                        # headless/CI: silent audio, captions carry the narration
aft all      --story story.md --platform todomvc --llm claude                # story → script → dry run → video
```

Add `--json` to any command for one JSON result on stdout (see "Agent primitives"). Exit codes: 0 ok · 1 usage/config · 2 SCRIPT failure · 3 app unreachable · 4 CRITERION failure · 5 APP error (see
"When a run fails"). Nothing prompts unless you ask (`login --manual`, `--headed --pause`).

Run folder contents: `tour.mp4` (the video), `tour.vtt` (captions), `recording.webm` (raw browser recording),
`clips/` (per scene), `scene-NN.wav` (narration), `timings.json` (scene windows in the recording), `screens/`
(a still per scene, discovery pages), `trace.zip` (Playwright trace), `tour.json` / `script.md` (generated
scripts), `validation.md`, `discovery.json`, `run.json` (command, args, status). On failure: `screens/failure.png`,
`trace-failed.zip`, `recording-failed.webm`. `out/<name>/latest.json` points at the newest successful run.

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
```

**App errors policy** (per target): `"appErrors": { "network": "fail"|"warn", "pageErrors": "fail"|"warn",
"console": "fail"|"warn", "ignore": ["<regex>"] }`. Default: warn (listed in the report, the step passes). Ignored
entries (known noisy endpoints or messages) stay in network.json/console.json marked `"ignored"`. `"errors"` names
the app's error UI (a selector plus text regex); it always fails the step.

### Known issues (workarounds)

A known app or environment issue (a service that isn't there locally, so a popup, an inline error panel, a toast or a
failing request) is declared once per platform as a **workaround**: what it looks like (`when`), what to do about it
(`do`), and how to report it (`as`). Tours never mention it; when the issue isn't there, nothing happens. Mocking the
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
- Checked before every step, on each poll while a step looks for its target or waits on a check, after each step
  (before the error UI), and when a click finds its target covered; in runs, validate, sessions (try-step, snapshot),
  login and discovery. Stacked known dialogs are closed newest first. Playwright's `addLocatorHandler` isn't used: it
  only fires inside Playwright's own actionability checks, which the paced recorder bypasses.
- Reported in report.json `workarounds` (each firing: name, source `platform` | `env:<name>`, what matched, action, the
  step) and `workaroundRules`, report.md "Known issues", the warnings and PROMPT.md. Matched requests and messages stay in
  network.json / console.json marked `"workaround": "<name>"`.

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
| `{ "verify": L }` | a check (CRITERION on failure); without a condition: visible. `text` / `exactText` compare the element's rendered text (innerText, whitespace collapsed, child elements included: `<strong>2</strong> items left` is "2 items left") or its source text, so a label CSS shows in capitals still matches as written ("Paused" for "PAUSED"); a check that fails only on case says so | `text` (contains or /regex/), `exactText`, `value`, `count` (visible matches), `state` (visible, hidden, enabled, disabled, checked, unchecked, selected, unselected, editable, focused; `selected` is aria-selected, for tabs and options; `checked` on a non-checkbox reads aria-selected / aria-checked / aria-pressed) |
| `{ "verify": { "url": "…" } }` / `{ "verify": { "title": "…" } }` | the page's URL / title contains (or /regex/) | |
| `{ "capture": L, "as": "code" }` / `{ "capture": { "url": true }, "as": "u" }` | remember a value from the page (a generated id or code, a link) for later steps as `"{vars.code}"`: an element's attribute, else a field's value, else its text; or the page URL. Using a value that was never captured is a SCRIPT failure | `attribute` (e.g. `href`), `pattern` (regex: keeps its first group, or the whole match) |
| `{ "dialog": "accept" \| "dismiss" }` | how to answer the next alert/confirm/prompt (default accept) | `text` (prompt answer), `expect` (message; CRITERION if different) |
| `{ "switchTo": "main" \| "popup" \| "last" }` | continue on another tab (see `opensPopup`); only the main tab is filmed | |
| `{ "download": L }` | click and save the download to `<run>/downloads/` | `saveAs`, `expect` (file name; CRITERION if different) |
| `{ "waitForResponse": "/api/x" }` | wait for a response; better as an option on the step that triggers it | `status` (else APP), `method` |
| `{ "mock": "/api/x", "json": … }` | canned responses for the rest of the run; needs `"allowMocks": true` on the tour (refused for `"style": "verification"`), and every mock is in report.json `mocks`, the warnings and a "Simulated data" caption; reusable sets: `platforms/<p>/mocks/<name>.json`, `"mocks": ["<name>"]` on the tour | `status`, `body`, `contentType`, `method`, `times` |
| `{ "wait": 1.5 }` / `{ "at": 0.5 }` | pause seconds / wait until that fraction of the narration | |
| `{ "use": "frag", "with": {…} }` / `{ "code": "x.mjs", "with": {…} }` | a fragment / a code step (see Platforms) | |

On any step: `optional`, `timeout`, `retries`, `criterion`, `comment`, and `waitForResponse` + `status` + `method`
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
`hasNot` (a locator inside it), `hasText` / `hasNotText`, `nth` (0-based: `"nth": 1` is the second match), and scoped by `within` (search inside the element
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

### Lifecycle

What happens when, and whether it can be skipped:

| when | what | skippable? |
|---|---|---|
| once per machine | `install.cmd` / `install.ps1`, then `aft doctor` | mandatory (doctor is idempotent; re-run after changes) |
| once per platform | `aft platform init <name>`, platform.json, environments.json, login.json, requirements.mjs, a smoke tour | mandatory |
| per environment | `aft platform check <name> --target <env>` | mandatory before the first real tour there; re-run when the app or environment changes |
| per env + role, until it expires | sign-in → `auth/<platform>/<env>/<role>.json` (`aft login`, or automatically on the first run) | skipped while the saved state works; renewed automatically on expiry when login steps and credentials exist; `--fresh-login` forces it |
| per session (one command) | launch or attach to the app; browser start | attach is skipped if the app is up; launch never restarts a running service |
| per run | fixture setup hooks → browser → session check → fixture steps (off camera) → scenes → fixture teardown | fixtures only if the tour lists them; teardown runs whenever setup ran |
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

They use the running session (`--session <name>`, where the name is `<platform>-<env>-<role or anon>` and is in `session start`'s output, or the only one for `--platform`); without one they open a one-shot
browser for that call (slower: start, sign in, close). A session is one page: state carries over between calls, and
calls run one at a time: a second call while one is running is refused (busy) rather than interleaved. try-step and
snapshot handle known issues (workarounds) as a run does and list them under `workarounds`.

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

## Story to video (for agents)

1. Save the story as a file (id like `RMS-6142`, title, description, `Acceptance criteria:` list); see
   `examples/stories/`.
2. `aft generate --story story.md --platform <name> [--target <env>] --llm claude [--style verification|demo|training]`
   (the tour it writes names the platform). Without
   `--llm` you get a per-criterion draft to fill in by hand. The style is a generation hint only.
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

## Rules

- **Synthetic or test data only.** Local or dedicated QA/test environments are fine; never production or real
  records. `validate` performs the steps for real, so it changes data like a run does.
- **The engine is app-agnostic.** Nothing in `src/` may know about a particular app; app specifics live only in
  `platforms/<name>/`. Tours hold no URLs, credentials, launch commands or app-wide selectors.
- **Never overwrite a previous run.** Use `newRunDir`; no fixed output paths, no shared temp files, free ports.
- **Rendering never depends on an LLM.** LLMs may write scripts; scripts are files a person can review.
- `--llm claude` sends the discovery inventory and story text to Claude; only use it where that's allowed.
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
| scene overruns its narration | a step waited for its timeout; mark it `"optional": true` (3 s limit) or fix the target |

Reading a trace: `npx playwright show-trace out/<name>/<run>/trace-failed.zip` shows every action with DOM
snapshots, the console and network; find the last red action.

## Code map

`src/cli.mjs` commands and run folders · `exchange.mjs` export/import between platforms · `schema-defs.mjs` the schemas' source, `schema.mjs` validation and messages · `steps.mjs` step runner, locators, suggestions, code steps · `declarative.mjs`
tour.json → a run (platform composition, launch/attach, login, hooks, fixtures) · `platform.mjs` platforms, fragments,
fixtures, init · `platform-cli.mjs` `aft platform` · `session.mjs` / `session-daemon.mjs` sessions, snapshot, locate,
try-step · `cli-app.mjs` the app a command targets · `recorder.mjs` Tour (paced recording, cursor, trace, mask) · `discover.mjs` crawl ·
`plan.mjs` heuristic and Claude planners, stories · `render.mjs` ffmpeg · `tts.mjs` speech · `auth.mjs` saved logins ·
`doctor.mjs` checks · `workarounds.mjs` known issues (merge, checkpoint, matching). Tests: `npm test`.
