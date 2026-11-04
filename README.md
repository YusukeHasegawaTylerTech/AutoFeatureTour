# AutoFeatureTour

Narrated feature-tour videos of web apps, from a user story or a hand-written script:

```
story ──generate──► tour.json + script.md ──validate──► every step resolved ──run──► tour.mp4 + tour.vtt
 (or a URL + brief)  (editable, reviewable)    (dry run, no video)               (paced to narration)
```

- **Script first.** `generate` writes an editable `tour.json` (steps) and `script.md` (narration) for a person to
  review before anything is recorded. Audience, tone, pacing and steps live in the script; the engine just runs it.
- **Any app.** Point it at a URL (local dev or a dedicated QA environment). Discovery crawls the app's screens;
  steps use user-facing locators (role, label, placeholder, text) the way stories describe the UI.
- **Fails clearly.** `validate` checks every step against the live app and suggests the closest match for anything
  it can't find; a failed step or `verify` stops a run with exit code 2, a screenshot and a Playwright trace.
- **Never overwrites.** Every command gets its own run folder.

## Install

Windows: double-click **`install.cmd`** (or run `powershell -ExecutionPolicy Bypass -File install.ps1 [-Link]`). It
installs Node 22+ and ffmpeg with winget if missing, runs `npm ci` and `npx playwright install chromium`, optionally
links the global `aft` command (`-Link`), and finishes with `aft doctor`. It's safe to re-run.

Elsewhere: Node 22+, ffmpeg/ffprobe on PATH, then `npm ci && npx playwright install chromium --with-deps`
(`npm link` for a global `aft`).

```
aft doctor                    # what's installed, what's missing and how to fix it (exit 1 if something required is missing)
aft doctor --platform <name> # also that platform's own requirements (platforms/<name>/requirements.mjs)
```

Without `npm link`, use `node src/cli.mjs` wherever this README says `aft`.

## Commands

```
aft generate --story <file|text> [--base-url <url>] [--llm claude] [--style verification|demo|training] [--prompt "..."]
aft validate <tour.json>        dry run: performs every step without recording; writes validation.md
aft run      <tour.json>        record the video
aft all      --story <file|text> --base-url <url> [--llm claude]     generate → validate → run in one run folder
aft auto     <url> [--prompt "..."]                                  discover → plan → run, no story
aft discover <url> [--max-pages 12] [--include <regex>] [--exclude <regex>]
aft plan     <discovery.json|run folder> [--story ...] [--prompt ...] [--llm claude]
aft render   <tour> [--record]  narration over title cards or hand-made clips (no browser), or a recording
aft login    --platform <name> [--target <env>] [--role <name>] [--manual]   (or aft login <tour.json>)
aft platform list | init <name> | discover <name> | check <name> [--target <env>]
aft doctor [--platform <name>] | --help | --version | --list-voices
```

| Flag | Meaning |
|---|---|
| `--platform <name>` | the app (`platforms/<name>/`) for generate, discover, login and doctor; tours name theirs |
| `--target <env>` (alias `--env`) | an environment of the platform (e.g. `local`, `qa`); `--role <name>` a login role |
| `--base-url <url>` | overrides the environment's URL; so does the `BASE_URL` environment variable (flag wins) |
| `--script <file>` | the tour file, as an alternative to the positional argument |
| `--out <folder>` | use this folder if it's new or empty; otherwise a run subfolder is made inside it |
| `--name <name>` | run name (default: story id + tour name) |
| `--headed` | show the browser (default headless) |
| `--speech sapi\|silent` | narration voice: Windows SAPI (default on Windows) or silent audio (default elsewhere; use it for CI) |
| `--voice <name>`, `--rate -10..10`, `--tail <s>` | SAPI voice, speed, pause after each scene |
| `--on-error fail\|skip` | skip steps that can't be done instead of failing (a failed `verify` still fails) |
| `--llm claude [--model <id>]` | plan with local `claude -p` instead of the built-in heuristic (see Data below) |
| `--no-captions`, `--no-record` | skip tour.vtt; `auto` without recording |
| anything else | passed to a `.tour.mjs` code tour as `ctx.options` (e.g. `--engine`, `--skip-build`) |

**Exit codes:** 0 ok · 1 usage/config · 2 SCRIPT (an action couldn't be performed) · 3 UNREACHABLE · 4 CRITERION
(a `verify` failed) · 5 APP (error UI, HTTP error or exception during a step) · 6 LOGIN · 7 TOOLING · 130 interrupted.
A failed run writes no `tour.mp4`; it writes a cause-first `report.md` and a **triage bundle** (`<run>/triage/`:
report, script with the failing step marked, ARIA snapshot, screenshot, trace, console and network errors per step,
PROMPT.md), with secrets scrubbed. See [AGENTS.md](AGENTS.md#when-a-run-fails). Hand triage: `--headed --pause`,
`--until-step N`, `--from-step N`, `--zip`. Everything is non-interactive unless you ask.

## Output

```
out/<story-id-or-tour>/<YYYYMMDD-HHMMSS>-<id>/     one folder per command, never reused
  run.json          command, arguments, status, timings
  discovery.json    screens/  (generate, auto, all)
  tour.json         script.md                      the script and its narration
  validation.md     validation.json                validate / all
  tour.mp4  tour.vtt  recording.webm  clips/  scene-NN.wav  timings.json  screens/scene-NN.png
  trace.zip         npx playwright show-trace <file>   (trace-failed.zip, screens/failure.png, recording-failed.webm on failure)
out/<name>/latest.json   pointer to the newest successful run      out/<name>/runs.jsonl   one line per run
```

Set `AFT_OUT_DIR` to put `out/` elsewhere. Concurrent runs are safe: separate folders, free ports for launched apps,
no shared temp files.

## Platforms and tours

An app is a **platform**, `platforms/<name>/`: `platform.json` (readiness, error UI, app-error policy and ignore list,
mask, pronunciations), `environments.json` (`local`, `qa`, … with `baseUrl` and `launch` or `attach`),
`login.json` (steps per role, credentials as `{env:NAME}`), `fragments/` (reusable steps, JSON or code),
`fixtures/` (test data with setup/teardown), `requirements.mjs`, `README.md` and `tours/`. A tour names its platform
and holds only what to show:

```json
{
  "name": "todomvc",
  "platform": "todomvc",
  "story": { "id": "TODO-101", "title": "Track tasks", "acceptanceCriteria": ["A user can add tasks"] },
  "scenes": [
    { "title": "Adding tasks", "url": "#/", "criteria": [1],
      "narration": "We type a task and press Enter. It appears in the list straight away.",
      "steps": [ { "use": "add-todo", "with": { "text": "Renew the permit" } }, { "verify": { "text": "Renew the permit" } } ] }
  ]
}
```

Steps: `goto`, `click`, `fill` (+`text`), `press`, `hover`, `point`, `select` (+`option`), `scroll`, `verify`, `waitFor`,
`wait`, `at` (a fraction of the narration), `use` (a fragment) and `code` (a code step). Any step can be
`"optional": true` or have a `"timeout"`. Actions spread across the narration automatically unless a scene uses `at`.
Targets: a plain string tries role (button, link, tab…), label, placeholder, then text; or be explicit with
`{ "role", "name" }`, `{ "label" }`, `{ "placeholder" }`, `{ "text" }`, `{ "testId" }`, and only as a last resort
`{ "css" }`; add `"nth"` to pick among matches. `npx playwright codegen <url>` finds the right role and name.

Onboarding a new app (`aft platform init` → doctor → login → `platform discover` → fragments → `aft platform check`),
the run lifecycle, fragments, code steps and fixtures: [AGENTS.md](AGENTS.md#platforms). Reference: the tops of
[src/platform.mjs](src/platform.mjs), [src/declarative.mjs](src/declarative.mjs) and [src/steps.mjs](src/steps.mjs).

**Logins** are saved Playwright storage state, `auth/<platform>/<env>/<role>.json` (git-ignored). `aft login` runs
the platform's login steps with credentials from environment variables or a `.env` file (git-ignored), or with
`--manual` opens a browser for SSO/MFA. Runs load the saved state, and sign in again off camera when it has expired.
Credentials never appear on camera or in a tour.

**Test data:** fixtures (`fixtures/<name>.json`, listed in the tour's `"fixtures"`) run setup/teardown hooks off camera
(`{ "run" }`, `{ "node" }` or `{ "http" }`, with `BASE_URL` and `RUN_DIR`) and optional browser steps before the first
scene. `validate` really performs the steps (without recording), so it changes data the same way a run does.

**Sensitive data:** `mask.selectors` (CSS) and `mask.patterns` (regex) are blurred in the page before anything is
recorded, so the video, screenshots and trace all see the blurred version. It's a hook point, not a guarantee.

## Stories → scripts

`aft generate --story story.md --platform <name> --llm claude` reads a pasted story (id such as `RMS-6142`, title,
acceptance criteria), crawls the app, and asks Claude for scenes that demonstrate each criterion, with `verify` steps
and narration that refers back to the criteria. Steps it can't ground are listed under `unresolved` in the script.
Without `--llm`, a story gives a draft with one scene per criterion for a person to fill in. Examples:
[examples/stories](examples/stories), and the result for one: [platforms/rms/tours/RMS-6142.tour.json](platforms/rms/tours/RMS-6142.tour.json).

## Code tours (.tour.mjs)

When a tour needs more than steps and code steps (building and launching a private app, seeding through an API,
custom helper pages), write a module: `export default { platform?, name, script, pronounce?, viewport?, async record(ctx) }`,
where `ctx` has `{ tour, scenes, outDir, options, toolRoot, targetDir, platformDir, log, run }` and `ctx.tour` offers
`start`, `scene(id, fn)`, `at`, `click`, `typeInto`, `moveTo`, `drag`, `helper(url)`, `screenshot`, `finish`.
Example: [platforms/agenticfoia](platforms/agenticfoia/README.md) (the app this tool started from).

## Data and environments

- **Synthetic or test data only.** Local or dedicated QA/test environments are fine; never production or real records.
- `--llm claude` sends the discovery inventory (screen names, labels, short text excerpts) and the story to Claude.
  Use it only where that's allowed for the app's data; the heuristic planner sends nothing anywhere.
- Scripts are files a person reviews. Recording never depends on an LLM.

## Next

Cross-platform voice (Piper) behind the speech provider interface · story input by Jira/ADO key · discovery that
explores state-dependent UI (after setup hooks or a scripted path) · per-sentence captions · `aft validate --fix`
applying closest-match suggestions.
