# Live editor: write and review a tour against the live, signed-in app

Planned. Not started. Spitballed 2026-11-05.

## Idea
Merge the Create and Review pages into one **live editor**. The script is written in place, against a staged app that
is signed in, has its fixtures in place and sits at the editor's cursor. You add the next steps by prompting, by picking
elements, or (later) by just using the app. Each step is tried live before it joins the script.

Story → draft isn't a separate flow any more. It's one way into the editor (see "Entry points").
[TODO-generate-conversation.md](TODO-generate-conversation.md) is the detailed design for that case.

Single user for now.

## Layout
```
Editor window (aft ui)                         App window (headed stage, its own window, e.g. full screen)
┌ Script ───────────────────────┬ thumbnail ┐  ┌────────────────────────────────────────┐
│ Scene 2: Filter by status     │ [still]   │  │                                        │
│  ✔ click "Active"             │           │  │      the real app, native input        │
│  ✔ verify count 2  [strong]   │           │  │                                        │
│  ▸ cursor                     │           │  │                                        │
├───────────────────────────────┴───────────┤  └────────────────────────────────────────┘
│ Prompt: "mark Beta done, check it moves"  │
└───────────────────────────────────────────┘
```

## Decisions so far
- **The app runs in its own window, not drawn inside the editor.** It's logically embedded (the editor drives it through
  the stage's control port: snapshot, locate, try-step) but visually separate. QA testers keep it full screen, input is
  native, and there's no forwarding.
  - Rejected: iframe (`X-Frame-Options`/CSP, third-party cookies break login/SSO, Playwright can't drive a frame in the
    user's own browser); screencast in a pop-out (forwarded input with gaps: keys, IME, file pickers, drag); Electron /
    WebView2 shell (true embedding, but it's a desktop product).
  - Borrow from embedding: launch editor and app as a **pair** (positioned side by side or on two monitors, named
    clearly, closed together when the stage ends).
- **Story → draft is one entry point** of the editor, not its own page.
- **Single user:** one stage per tour and environment, owned by the editor. A second editor on the same tour opens it
  read-only, with "take over" (= `stage --redo`).

## Building blocks (mostly exist)
- `aft stage` (src/stage.mjs) gives live state up to a point; moving the cursor back = `stage --redo --until-step N`,
  undone through the ledger.
- `try-step` (src/session.mjs) returns each step's report entry plus the ARIA tree after it: the context for the next
  proposal.
- "Pick from the page" (UI) supplies locators.
- Review (src/review.mjs): evidence and findings shown per step as it's written, not only after a run.

## Step states in the editor
- ✔ ran live here · ✘ failed (suggestions plus ARIA tree shown) · ○ not run since an edit (hand-written or stale).
- **Pending** (yellow): what the LLM proposed. It becomes script only after it passes live.
- **Stale from here** marker when an earlier step is edited, with one-click "re-stage to cursor" (`--from-step`
  fast-forward to keep it quick).

## Keeping the two windows in sync
- Thumbnail in the editor: the latest screenshot after each step (or a low-fps screencast). It's just for glancing at;
  you never type into it.
- Pick from the app: "Pick element" puts a highlight overlay into the app window (an init script). The click goes to
  the editor as a locator at the cursor. Hovering a step in the editor flashes its target in the app.
- Optional in-app toolbar (prompt, add step, pick, undo to here) so a full-screen tester never switches windows. It
  has to be kept out of the recording and the ARIA snapshot (shadow DOM, filtered by the engine). **Not in v1.**
- Recording by watching (later): the tester's own clicks and typing become proposed steps (codegen-like, mapped to
  our locators). The LLM writes the checks and the narration.

## Entry points
- **From a story:** one scene stub per acceptance criterion. The LLM drafts each scene's steps against the live page
  (TODO-generate-conversation.md).
- **From a URL / nothing:** an empty tour, then prompt or pick (or record, later).
- **From an existing tour / failed run:** stage to the failing step and fix it live (suggest-fix output appears as a
  pending block).

## Risks / rules
- **Checks restating the screen:** the LLM must write `verify` expectations from the story's criteria, not from what
  the page shows (the same rule as suggest-fix). The UI flags any check whose expected value was read off the page.
- **try-step really changes data:** "undo last step" = re-stage from the start, or ledger item-level undo where an
  item exists. Synthetic data only.
- **Scope** (the "open heart surgery" check): the core is live state, every action written down, and the result a plain
  tour file. A feature that serves none of these belongs to the tester's other tools.
- **Live data is louder here:** people click faster in a live editor than in a batch run, so the synthetic-data /
  shared-environment warnings stay visible on the editor, not only in the run log.
- **Narration** is drafted per scene once its steps settle; "preview this scene" = render (title card plus TTS) for
  that scene only.
- Nothing on the run/render path uses an LLM; the result is a normal tour file.

## Reuse Playwright (checked against the installed 1.64.1, 2026-11-05)
Rule: use Playwright for **browser mechanics** (picking, highlighting, ARIA, refs, traces). Keep ours for anything that
carries **our rules**: step format, locator resolution and suggestions, workarounds, ledger, review. Use public APIs
only; no `_private` ones (they change without notice).

| need | use | notes |
|---|---|---|
| Pick from the app | `page.pickLocator()` / `cancelPickLocator()` | Playwright's own overlay in the app window. It returns a Locator; `toString()` gives `getByRole('button', { name: 'Save' })` etc., which we convert to our locator and confirm with our resolver (steps.mjs `candidates`), falling back to capture.mjs `bestTarget` scoring. Replaces the planned custom overlay; the UI's current pick (simple.js:822) can switch to it |
| Flash a step's target on hover | `locator.highlight()` / `page.hideHighlight()` | Stage only (nothing is recorded there). Also flashes "did you mean" matches on a ✘ |
| LLM proposing steps | `page.ariaSnapshot({ mode: 'ai' })` refs (`[ref=e2]`), `page.getByRef('e2').normalize()` | The LLM answers with a ref instead of inventing names; `normalize()` turns it into a role/name locator, which we convert and confirm as above. Cuts "target not found" from hallucinated names. Refs resolve against the latest snapshot, so take the snapshot and resolve in the same turn |
| Vitals backfill | `page.consoleMessages()`, `page.pageErrors()` (last 200), `page.requests()` | For when the editor attaches to a stage that's already running. Live vitals still come from always-on `page.on('console' / 'pageerror' / 'requestfailed' / 'response')` listeners in the stage daemon, which also cover the tester's manual clicks (`requests()` entries get collected, so they're no good as the main source) |
| Readable traces / errors | `locator.describe('<step key> <action>')` | Steps show by name in the trace viewer and in Playwright errors. Cheap; for runs too |
| ✘ details | trace viewer (`npx playwright show-trace`) | Link it, don't rebuild it. Live per-step trace: `tracing.startChunk()` / `stopChunk({ path })` around each try-step, opt-in (traces hold cookies/DOM, as `"trace": false` notes) |
| Hand inspection | `page.pause()` (Inspector) | Already behind `--headed --pause`; an editor button "open the Inspector here" on a stage |

Deliberately not reused:
- **Codegen's recorder** (`context._enableRecorder`): private, and it emits Playwright code, not tour steps.
  `src/capture.mjs` already records into our steps with our resolver; keep it. Use `pickLocator` and refs where they
  give better targets.
- **Playwright test agents** (planner / generator / healer, `node_modules/playwright/lib/agents/`) and **Playwright MCP**:
  they write `.spec.ts` files and drive the browser directly, bypassing workarounds, the ledger, mocks policy and the
  review rules. Read their prompts for ideas (`playwright-test-*.prompt.md`); the agent loop stays on
  snapshot / locate / try-step.
- **Screencast thumbnail:** 1.64 has no public screencast API; use `page.screenshot()` after each step (CDP
  `Page.startScreencast` would be Chromium-only and private-ish). This settles the thumbnail question.
- `routeFromHAR`: our mocks cover it; `toMatchAriaSnapshot`: maybe later, as a `verify` option for structure checks.

Already in the repo (found while checking): recording by watching (`src/capture.mjs`, `aft converse --record N`,
session/stage ops `record-start` / `record-steps` / `record-stop`) and the conversation (`src/converse.mjs`,
`ui/public/converse.js`). v1 item 4 is mostly wiring these into the editor, not new work.

## QA walkthrough (2026-11-05)
Imagined with a messy story: RMS-7031 "hate bias flag on supplements + supervisor approval". It has two roles plus a
conditional third (watch commander when the author is a supervisor), an open question ("check w/ Dana"), legacy data
the UI can't create (pre-2024 supplements), an export check, and acceptance criteria partly in the comments.

Main finding: **testers will use this as a test session tool first and a video maker second.** The video is the
receipt. What they need from it:

1. **Story ambiguities as questions.** Generating from a story lists what it couldn't pin down ("check w/ Dana", "red
   icon?", "AC: see comments") at the top, as blocking questions. Each one can be answered, or marked "ask the PO". When
   it's ambiguous it stops rather than guessing.
2. **Role per scene, and switching partway through the tour.** Each scene shows its role and can switch it (officer
   writes, supervisor approves). The app window re-signs in, or a second window per role is swapped in (saved logins,
   `--as`). Almost every approval story needs this.
3. **Data needs first-class.** When a criterion needs data that can't be made by clicking (old records, other users'
   records), the editor says so up front and offers "find me one" (a fixture item with a lookup hook, `output` +
   `as`). The tester shouldn't find out when the scene fails.
4. **Do it, don't describe it.** Recording by watching plus the in-app toolbar, so a full-screen tester never
   alt-tabs. Prompting stays for "write the checks / narration for what I just did".
5. **Suggested edge cases.** From the criteria, propose boundary, permission and legacy-data cases (19/20 chars, empty,
   whitespace; approving your own report; old records), each one an optional scene to accept or reject.
6. **On every failed check: "app or script?"**, defaulting to *app* for checks. One click marks it `knownIssue`, files a
   ticket from here (bundle, screenshot, steps to reproduce taken from the script) and **carries on** with the next
   criterion. The pending-step flow must not train testers that ✘ means "fix the script".
7. **Checks on downloaded files.** A step that checks what's inside a download (CSV/XLSX: contains, a row matching,
   row count), so exports don't need a code step. New engine step and schema change; app-agnostic.
8. **Scene status "blocked: question".** A scene can wait on an open question without being deleted. The verdict reads
   it as **not tested**, never passed.
9. **Per-story status from the live session.** A shareable summary before any video exists: "5 ACs: 3 pass, 1 known
   issue (RMS-7044), 1 blocked on a question". It's built from the live results, not only a full clean run. Recording
   the video is the last step.
10. **Re-test after the fix.** Reopen the tour, stage to the failing scene (data kept with `--keep`), rerun just that
    check. This is the strongest selling point: keep it one click.

## v1 (re-cut after the QA walkthrough)
1. Review page plus a "live" toggle that attaches to (or starts) a stage of the tour; editor and app as a window pair.
2. Step list with ✔ / ✘ / ○ from try-step; cursor; insert at cursor; re-stage to here.
3. Pick from the app → step at cursor.
4. **Recording by watching** plus a minimal in-app toolbar (record on/off, pick, add check). (QA 4)
5. **Role per scene with switching.** (QA 2)
6. **Failed check → "app or script?"**, defaulting to app; knownIssue plus carry on. (QA 6)
7. **Scene status blocked/question**, and a per-story status summary from the live session. (QA 8, 9)
8. Re-test a failing scene in one click. (QA 10)
9. **Vitals panel**: always-on, live beside the script. It shows the app's failing requests, console errors and
   uncaught exceptions, known issues (workarounds) firing, and pages that never settled. Each entry is tagged with the
   step that was running (`stepKey`, as in network.json / console.json). It shows the `appErrors` policy outcome
   (warn / fail / ignored) and links to the step. It covers the tester's own manual clicks too, between steps (the
   stage's page listeners, not only try-step). Cheap: try-step and the session already collect these per step.

Then:
- prompt box (generate scoped to one scene, given the current ARIA tree and the criterion) with story ambiguities as
  questions (QA 1);
- data needs and "find me one" (QA 3);
- suggested edge-case scenes (QA 5);
- download content checks (QA 7);
- live review badges;
- filing a ticket from the editor.

## Open questions
- Role switching: re-sign in within one window (simpler, slower) or one window per role (faster, more windows for a
  full-screen tester)?
- Ticket filing: which tracker (Jira via API?), or just a ready-to-paste bundle plus text in v1?
- ~~Thumbnail: screenshots or screencast?~~ Screenshots (no public screencast API; see "Reuse Playwright").
- ~~Recording by watching: event → locator mapping?~~ Exists in src/capture.mjs.
