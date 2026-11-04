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
| `<app>: …` | that target's own requirements; see `targets/<app>/README.md` |

## Running

```
aft validate examples/todomvc/tour.json                          # dry run: every step, no video → validation.md
aft render   examples/todomvc/tour.json                          # preview: narration over title cards, no browser
aft run      examples/todomvc/tour.json --target demo            # record (an environment from the tour's "environments")
aft run      my.tour.json --base-url http://localhost:3000/      # local dev server (or BASE_URL=...)
aft run      my.tour.json --target qa                            # deployed QA environment (+ saved login, see below)
aft run      my.tour.json --speech silent                        # headless/CI: silent audio, captions carry the narration
aft all      --story story.md --base-url <url> --llm claude      # story → script → dry run → video
```

Exit codes: 0 ok, 1 usage/config/unexpected, 2 step or `verify` failed (or validate found unresolved steps), 3 app
unreachable. Nothing prompts unless you ask (`login --manual`, `--headed`).

Run folder contents: `tour.mp4` (the video), `tour.vtt` (captions), `recording.webm` (raw browser recording),
`clips/` (per scene), `scene-NN.wav` (narration), `timings.json` (scene windows in the recording), `screens/`
(a still per scene, discovery pages), `trace.zip` (Playwright trace), `tour.json` / `script.md` (generated
scripts), `validation.md`, `discovery.json`, `run.json` (command, args, status). On failure: `screens/failure.png`,
`trace-failed.zip`, `recording-failed.webm`. `out/<name>/latest.json` points at the newest successful run.

## Adding a target app

Start from `examples/todomvc/tour.json`; most apps need nothing more than a `tour.json`.

1. `targets/<app>/<tour>.tour.json` (or anywhere). Set `environments` (`local`, `qa`, …) with each `baseUrl`; the
   same script then runs against each with `--target`. `--base-url` / `BASE_URL` override.
2. Login: add `"login": { "role": "...", "steps": [...] }` with credentials as `"{env:NAME}"` (from env vars or a
   git-ignored `.env`). `aft login <tour.json> --target qa` saves `auth/<target>-qa/<role>.json`; for SSO/MFA use
   `--manual` and log in by hand. Runs load the saved state; re-run `login` when it expires.
3. Test data: `"hooks": { "setup": [...], "teardown": [...] }` with `{ "run": "<cmd>" }`, `{ "node": "<script>" }` or
   `{ "http": { "method", "url", "body" } }`. Hooks get `BASE_URL` and `RUN_DIR`.
4. Sensitive data on screen: `"mask": { "selectors": [...], "patterns": [...] }` blurs it before recording.
5. Slow screens: `"timeouts": { "action", "verify", "waitFor", "navigation" }` (ms), per environment if needed.
6. Starting the app: `"launch": { "command", "cwd", "port": "auto", "healthUrl" }` (optional).
7. Extra machine requirements: `targets/<app>/requirements.mjs` (see `src/doctor.mjs`), checked by `aft doctor`.
8. Only if steps aren't enough (building the app, API seeding, helper pages): a `.tour.mjs` code target, like
   [targets/agenticfoia](targets/agenticfoia/README.md). Its CLI options pass through as `ctx.options`.

## Story to video (for agents)

1. Save the story as a file (id like `RMS-6142`, title, description, `Acceptance criteria:` list); see
   `examples/stories/`.
2. `aft generate --story story.md --base-url <url> --llm claude [--style verification|demo|training]`. Without
   `--llm` you get a per-criterion draft to fill in by hand. The style is a generation hint only.
3. Review and edit the run folder's `tour.json`:
   - one scene per acceptance criterion (`"criteria": [n]`), narration saying which criterion it shows;
   - targets as visible names: `{ "role": "button", "name": "Run report" }`, `{ "label": "Hate Bias Status" }`,
     `{ "text": "Case Detail" }`; CSS only as a last resort. `npx playwright codegen <url>` shows the role/name;
   - `verify` for whatever a criterion requires to be visible; no destructive actions unless the story needs them;
   - anything listed under `unresolved` needs a person or a discovery of the right screen.
4. `aft validate <run>/tour.json`; fix each ✘ in `validation.md` (it suggests the closest names on the page), repeat.
5. `aft run <run>/tour.json` (records into a new run folder).

## Rules

- **Synthetic or test data only.** Local or dedicated QA/test environments are fine; never production or real
  records. `validate` performs the steps for real, so it changes data like a run does.
- **The engine is app-agnostic.** Nothing in `src/` may know about a particular app; app specifics live only in
  `targets/<app>/` (or the tour file).
- **Never overwrite a previous run.** Use `newRunDir`; no fixed output paths, no shared temp files, free ports.
- **Rendering never depends on an LLM.** LLMs may write scripts; scripts are files a person can review.
- `--llm claude` sends the discovery inventory and story text to Claude; only use it where that's allowed.
- Never commit `out/`, `auth/` or `.env`.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| `ffmpeg not found` | install it (see Setup) and open a new terminal |
| `The sapi speech provider needs Windows` / no voices | `--speech silent` |
| `Target not found: …` (exit 2) | the name differs on the page; see the "did you mean" suggestion, or `aft validate` for all of them; check with `npx playwright codegen <url>` |
| `Verification failed` (exit 2) | the app doesn't show what the criterion expects, or it's slow: raise `timeouts.verify` |
| lands on a login page / 401s | saved login expired: `aft login <tour.json> --target <env>` (`--manual` for SSO) |
| `No saved login at …` | the tour has `login` without steps: run `aft login --manual` first |
| exit 3, `didn't come up` | app not running at `baseUrl`, or `launch.healthUrl` wrong; see `app.log` |
| scene overruns its narration | a step waited for its timeout; mark it `"optional": true` (3 s limit) or fix the target |

Reading a trace: `npx playwright show-trace out/<name>/<run>/trace-failed.zip` shows every action with DOM
snapshots, the console and network; find the last red action.

## Code map

`src/cli.mjs` commands and run folders · `steps.mjs` step runner, locators, suggestions · `declarative.mjs` tour.json
(environments, login, hooks, mask) · `recorder.mjs` Tour (paced recording, cursor, trace, mask) · `discover.mjs` crawl ·
`plan.mjs` heuristic and Claude planners, stories · `render.mjs` ffmpeg · `tts.mjs` speech · `auth.mjs` saved logins ·
`doctor.mjs` checks. Tests: `npm test`.
