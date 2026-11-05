# Generate as a conversation: the agent explores the app, the person decides, records, refines

Implemented (src/converse.mjs, src/capture.mjs, src/narrate-timing.mjs, `aft generate --converse`, `aft converse`,
ui/public/converse.js). Left open: screenshots as image input (probes send ARIA and text only); the UI's step timing
still has its own copy of src/narrate-timing.mjs (it runs in the browser); an aft-ui tour of the chat flow.

## Context
Today GENERATE (ui/public/simple.js:586 `genPanel`, `generate()` :914) is one shot: paste a Jira story, it runs
`aft generate --story … --llm claude` (src/plan.mjs:245 `plan()`, one `claude()` call at :203 with `--tools ''`
over a crawled inventory), and the scenes replace the editor's. Wrong targets, unclear criteria and missing data come
back as `unresolved` strings, and the person fixes them by hand.

Goal: turn this into a **conversation** in the same GENERATE panel:
- the agent **explores the live app** (snapshot, locate, try-step on the conversation's stage) to work out each
  criterion's steps, and writes steps it has tried;
- it **comes back with questions** and options; the person **decides** (buttons or free text), and it picks up there;
- for steps that are quicker to do by hand, the person **records** them in the live browser (codegen-like) and the
  agent **writes the narration** (and suggests checks) from what was recorded;
- the person can keep **refining** ("scene 3 is too long", "use the Approve button", "add a check for the total").

Constraints kept: engine app-agnostic; nothing on the run/render path uses an LLM; the result is a normal tour file a
person reviews; synthetic data only (probing does real actions, like validate).

## Design

### A. The conversation is a run folder (`out/<story>/<run>/`, `newRunDir`)
- `conversation.json` (schema `aft-conversation/1`): `story`, `platform`, `env`, `role`, `stageName`,
  `claudeSessionId`, `state` (`exploring | waiting | recording | done | failed`), `turns[]` (`{ who: agent|person|tool,
  at, text, questions?, answers?, probes?, sceneUpdates? }`), `decisions[]`, `budget` (probes used / limit), and
  per-scene state (`planned | explored | recorded | verified`).
- `tour.json` in the same folder is the **draft**, rewritten after each turn. It is always a valid tour: the tour and
  scene schemas are strict (`additionalProperties: false`, src/schema-defs.mjs:289, :321), so it carries no extra
  draft keys. Unfinished work uses the existing scene fields: `todo` (a step not yet tried, or refused, with the
  reason) and `unresolved`; both already block recording.
- `ledger.json` covers what probing created: probes run on the conversation's **stage** (see B), so staged data and
  data-creating try-steps are in its ledger, tagged `{run.tag}`, and undone when the conversation ends.
- Resumable: a closed UI, a crash or a next-day return continues from `conversation.json`.

### B. The agent loop: `src/converse.mjs` (new). The engine drives it; Claude never gets a shell
Each **turn**: the engine sends Claude the state (story, criteria, draft, last probe results, the person's latest
message/answers) and Claude returns one structured reply (JSON schema) with any of:
- `probes[]`: `snapshot {url?}`, `locate {target}`, `tryStep {steps}`, `stageTo {scene, step?}`. One daemon only: the
  conversation's **stage** (src/stage.mjs / src/stage-daemon.mjs), built from the draft `tour.json`; it already answers
  snapshot/locate/try-step, and `stageTo` is a stage `--redo` to that point. No separate session. Results go back next
  turn (ARIA and text trimmed, the platform's `mask` and the report redaction applied). `claude()` runs with
  `--tools ''`, so it can't open files: screenshots are sent as image input or not at all (ARIA/text only).
  Try-steps that create data are recorded in the stage's ledger so they are undone too. Up to N probe rounds per turn
  (budget) before it must report.
- `scenes[]`: create/update scene i (title, narration, url, criteria, steps). Steps that passed `tryStep` in this
  conversation are preferred, but that is a hint only (success depends on app state, `{vars}`, `{data}` and fragment
  expansion); untried or refused ones go into the scene's `todo` with the reason. The real gate is `aft validate` of
  the draft: a scene is `verified` only after it passes there, and `--finish` runs it. Never a check weakened to match
  what the app shows (rule shared with src/fix.mjs).
- `questions[]`, typed so the UI renders buttons and answers apply mechanically:
  `choose-target {candidates}`, `criterion-ambiguous {proposal}`, `missing-data {options: value|fixture|setup}`,
  `role`, `blocked {request,status} → workaround|app-issue|skip`, `confirm-destructive`, `record-this {scene}`
  (asks the person to do it by hand), `free-text`. Each with evidence (screenshot path for the UI, ARIA excerpt).
- `say`: a short message for the chat.
- Then the state is `waiting` (questions or done) or loops (more probes).
- Claude context: `claude -p --output-format json --json-schema … --resume <claudeSessionId>` so turns share
  context; extend `claude()` in src/plan.mjs with `resume` and return `session_id`. Check first that
  `--system-prompt` and `--json-schema` take effect on resumed `-p` turns; if they don't, the fallback below is the
  default. Start turn reuses the existing `SYSTEM` rules and `inventoryFor` (plan.mjs:154, :195) plus the exploration
  rules. Fallback when resume isn't available: send the compacted conversation each turn.
- Guardrails: probing only on a stage of a non-production env; `shared` envs need `{run.tag}` data
  (existing warning in fixtures); destructive actions only after a `confirm-destructive` answer; probe budget per
  scene; all probes logged in `turns` (and network/console errors, as try-step reports them).

### C. Recording by hand: `src/capture.mjs` (new)
- `startCapture(page, { onStep })`: `exposeBinding('__aftCapture')` + `context.addInitScript` (survives navigation;
  same pattern as src/recorder.mjs:126); listens for click, dblclick, change (check/radio/select), input → one `fill`
  per field (on blur/Enter), Enter/Escape outside text → `press`, top-level navigation not caused by a click → `goto`
  (relative path).
- In page: describe the element (role, accessible name, label, placeholder, testId, named container for `within`,
  CSS fallback). Node side: choose the best locator by trying role+name → label → placeholder → text → testId →
  `within` → `nth` → CSS with the existing resolver (src/steps.mjs `candidates()` :27) and keep the first unique one
  that is the same element; CSS/nth marked as weak.
- Password fields → `"secret": true` with `{data.<name>}` and a `missing-data` question (the value is never written).
  New record id in the URL after a create → a suggested `pin` (src/review.mjs `pin?` heuristic).
- Collapse noise (label click → check, repeated fills, click-then-fill).
- Daemon ops `record-start {scene, afterStep?}`, `record-steps`, `record-stop` in src/stage-daemon.mjs (:136; the
  stage is headed) and src/session-daemon.mjs (:55, for `session start --headed` users outside a conversation).
  Record runs while status/record-steps answer. A still after each step goes to the run folder for narration.
- After `record-stop` the engine starts an agent turn "the person recorded scene i: steps + stills": Claude writes
  the narration (fitted to the steps' duration: move `stepSeconds` from simple.js:163 into src/narrate-timing.mjs,
  plus `estimateSeconds` src/tts.mjs:17) and proposes `verify` steps for the criterion, which it tries before offering.

### D. CLI (all `--json`)
Exit codes stay failure classes (src/failures.mjs). Waiting on the person is exit 0 with `data.state: "waiting"` and
`data.questions`; done is exit 0 with `data.state: "done"`.
- `aft generate --story s.md --platform p --llm claude --converse [--target env] [--role r]` → starts the stage,
  runs turns until questions/done; prints them.
- `aft converse <run> --say "…" | --answer q3=Approve [--answer …] | --record N [--after-step J] | --stop`
  continues the conversation. `aft converse <run> --finish` validates the draft, writes the tour (as generate does
  today, `$schema` first) and ends the stage (undoing probe data).
- One-shot `aft generate` (no `--converse`) stays as it is.
- Server: add `converse` to `ALLOWED` (ui/server.mjs:249); the turns stream as job lines as today.

### E. UI: the same GENERATE panel, as a chat
- Pasting the story and ✨ WRITE THE SCENES starts the conversation (opt-out checkbox "one go, no questions" keeps the
  old behaviour). The panel becomes a chat: agent messages, "🔎 looked at /cases (3 tries)" probe summaries
  (expandable), question cards with option buttons + evidence thumbnail, a text box for free replies.
- Scenes fill in below as they're explored (badges planned / explored / recorded / verified, from conversation.json);
  the stage card shows the live browser (↗ Open). A question `record-this`, or ⏺ RECORD on any scene/step, starts
  capture: live list of recorded steps, ↶ drop last, ⏹ STOP → the agent narrates.
- Refining: any message after "done" ("shorten scene 3", "check the total is 42") is a new turn on the same draft.
- ✔ USE THESE SCENES = `--finish` into the editor (dirty, then SAVE as today). Closing the panel keeps the conversation;
  reopening the script offers "continue the conversation".
- Decisions the person made that belong to review (known issue, app issue) are written as
  `review.decisions` / workarounds proposals, shown for confirmation, never applied silently.

## Critical files
New: src/converse.mjs, src/capture.mjs, src/narrate-timing.mjs (shared estimator), tests test/converse.test.mjs (stub
`claude()`, fake stage: reuse the fakes in test/stage.test.mjs and test/primitives.test.mjs), test/capture.test.mjs
(fixture page).
Edit: src/plan.mjs (`claude()` resume + session id, export SYSTEM/inventoryFor), src/stage.mjs, src/stage-daemon.mjs
(record ops; data-creating try-steps into the ledger), src/session-daemon.mjs (record ops), src/cli.mjs (generate
--converse, converse, help block), src/schema-defs.mjs (+ `npm run schemas`: conversation schema only),
ui/public/simple.js (chat panel), ui/public/stage.js (reuse card), ui/server.mjs, ui/public/style.css, AGENTS.md (the
loop, `state: waiting`; and the data rule: `--llm claude --converse` also sends the live page's ARIA tree, text and
errors, masked and redacted, not just the discovery inventory and story), ui/README.md.

## Verification
- Unit: converse with a scripted fake `claude()` reply sequence and a fake stage: probes run, untried steps are kept
  as `todo`, questions → exit 0 + `state: waiting`, answers resume, `--finish` validates and writes a valid tour
  (schema check), probe data is undone at the end. Capture: fixture page with button, labelled field, checkbox in a
  row, duplicate names, password, navigation → expected steps.
- End to end on todomvc: `aft generate --story examples/stories/<todo>.md --platform todomvc --llm claude --converse`,
  answer, `aft converse <run> --record 2`, do it by hand, `--finish`, then `aft validate` and `aft run` pass.
- In the UI (aft-ui `fresh` env): full chat flow; then extend platforms/aft-ui/tours with a tour of it.
- `npm test` green.

## Order
0 check `claude -p --resume` keeps the system prompt and schema → 1 converse loop + probes + questions in the CLI
(biggest value) → 2 capture + record + narrate → 3 UI chat panel → 4 refine turns, review decisions, polish.
