# TODO

## Platform-level workarounds (`workarounds`)

**Problem:** a known app or environment issue (e.g. RMS with TCM down) shows error UI: a full-screen popup, an
inline error panel, a banner, a toast. Handling it inside the tour makes the tour depend on the broken environment:
in a working one the step fails (SCRIPT) or burns its timeout. Mocking TCM isn't the answer: it hides a real problem
and the real service. And an inline panel may not block anything but still match the platform's `errors` UI and fail
the step (APP).

**Approach:** known issues are declared once per platform as workarounds: what it looks like (`when`), what to do
about it (`do`), and how to report it (`as`). Tours never mention them; when the issue isn't there, nothing happens.

```json
"workarounds": [
  { "name": "TCM unavailable popup",
    "when": { "role": "dialog", "hasText": "/TCM|service unavailable/i" },
    "do": [ { "click": { "role": "button", "name": "OK" } } ],
    "as": "warn" },
  { "name": "TCM status panel",
    "when": { "css": ".error-panel", "hasText": "/TCM/" },
    "do": "tolerate",
    "as": "warn" },
  { "name": "TCM lookup 503",
    "when": { "request": "/api/tcm/", "status": "5xx" },
    "do": "tolerate",
    "as": "warn" }
]
```

- **`when`**: one of: a locator (popup, panel, banner, toast); a failing request (`request` + `status`); a console or
  page-error message (`console: "/regex/"`). It can be narrowed to `paths` (URL patterns) where it applies.
- **`do`**:
  - steps (`[...]`), to dismiss it: click OK, close the toast, press Escape. The UI has to be gone afterwards (unless
    `noWaitAfter`).
  - `"tolerate"`: leave it on screen. It doesn't fail the step through `errors` / `appErrors`, and it doesn't count as
    covering a click target unless it really does.
  - `"hide"` (maybe later): hide it with CSS for the video. This fakes the app's state, so it gets the same caution
    as mocks.
- **`as`**: `warn` (default; listed in the report, run passes) | `fail` (APP, exit 5: "this known issue must not
  happen here") | `silent` (counted in report.json only).
- Optional `times` (max firings, then it's a normal error again).

### Tasks

- [ ] **Schema**: `workarounds` on the platform in `src/schema-defs.mjs` (`name`, `when` = locator | request |
      console, `paths`, `do` = steps | `tolerate` | `hide`, `as`, `times`, `noWaitAfter`); `npm run schemas`.
- [ ] **Per environment**: `workarounds` also allowed on each environment in `environments.json` (same schema).
      Merged by `name`: platform rules apply everywhere. An environment rule with the same name replaces the
      platform's for that environment's runs, e.g. `{ "name": "TCM unavailable popup", "as": "fail" }` in qa, or
      `"off": true` to disable it there. A new name adds a rule only for that environment. Partial entries are
      merged over the platform's rule.
- [ ] **Loader**: merge platform + selected environment (after `--target`) in `src/platform.mjs` /
      `src/declarative.mjs`; `--base-url` one-offs use the platform rules only. report.json records each rule's
      source (`platform` | `env:<name>`).
- [ ] **Own checkpoint, not `page.addLocatorHandler`**: Playwright only fires that before its own actionability
      checks and `expect` assertions; this engine bypasses both (`Tour.click` = `coveredBy` + `page.mouse.click`,
      `resolve` polls `count`/`isVisible`, `verify` polls with `until`). Write `applyWorkarounds(page)`: for each
      locator workaround whose `when` is visible, do it (steps → wait until gone; tolerate → mark), record it, honour
      `times`. No reentrancy (steps inside a workaround don't trigger workarounds).
- [ ] **Error classification**: in the `errors` UI check and the `appErrors` policy, match request, console and
      locator workarounds first. A match is reported under its name and not as an app error (like `ignore`, but named,
      visible in the report, and able to fail with `as: fail`). Replaces the `errors` precedence question below.
- [ ] **Covered-by**: in `Tour.click`, a cover that matches a `do`-steps workaround → handle it and re-check. A
      tolerated element that really covers the target still blocks.
- [ ] **Call sites**: before each step (`steps.mjs` runner); each poll in `resolve` and `verify`'s `until`; in
      `Tour.click` when `coveredBy` reports a cover → handle, then re-check once before "action blocked".
- [ ] **Plumbing**: pass handlers to `Tour` and `plainActor` so login, fixture steps, discovery and sessions match.
- [ ] **Steps inside a workaround**: run them unpaced and off narration; a failing one is a SCRIPT failure naming
      the workaround.
- [ ] **Reporting**: each firing → `report.json` `workarounds[]` (name, what matched, time, the `stepKey` that was
      running) + a warning; in `report.md`, triage bundle and `PROMPT.md` ("known issue X occurred").
- [ ] **Policy**: `"as": "fail"` → APP failure (exit 5) with "first cause" = the workaround's name.
- [ ] **Video**: dismissed or tolerated UI is filmed. Option: mark windows in `timings.json` and trim in
      `render.mjs`. Start with accept + warning.
- [ ] **Sessions**: apply workarounds in `session-daemon.mjs` too, so `try-step` / `snapshot` behave like a run.
- [ ] **Tests** (fixture server): popup at a random step → dismissed, warning; inline error panel matching `errors`
      → tolerated, passes, warning; 5xx on a matched request → tolerated; `as: fail` exits 5; `times` exceeded →
      normal failure; issue absent → no warnings, no delay.
- [ ] **Docs**: `AGENTS.md` (Platforms table, "When a run fails", Troubleshooting row) and README.
- [ ] **RMS**: add the TCM workarounds to `platforms/rms/platform.json`; remove the click-away step from its tours.

### Stopgap (now)

- [ ] Mark the RMS tour's popup click-away step `"optional": true` until the handler lands.
## Mocking (later)

- [ ] Gate `mock` by `--style`: allow for demo/training; for verification refuse, or downgrade criteria to warnings.
- [ ] Optional "simulated data" badge/caption on scenes where a mock answered.
- [ ] Platform mock sets: `platforms/<p>/mocks/<name>.json`, referenced from tours like fixtures.

## From the RMS-6399 run (rms-local-dev, 2026-11-04)

### Workarounds: details the run showed

- [ ] **Stacked dialogs**: two known dialogs were open at once (IBR build edits + File Storage). Handle matches
      newest first, loop within one checkpoint, wait for each to close before the next. Test: two stacked known dialogs.
- [ ] **Scope `do` steps to the match**: `{ "role": "button", "name": "Ok" }` hit the other dialog's actions
      container ("covered by"). Run `do` steps `within` the matched `when` element by default.
- [ ] **Tolerated inline text on camera**: the IBR tab shows "Edit check service unavailable, try again later".
      Feeds the Video task: at least a caption ("known local-dev issue") for tolerated UI.
- [ ] **RMS rules**: needed in `platforms/rms-local-dev` too, with an extra rule for "Unable to retrieve Case/Arrest
      build edits." (no IBR service locally, `IbrServiceInstalled: false`). Then replace the stopgap: the
      `errors.text` negative lookahead and `fragments/dismiss-local-env-errors.mjs`, and drop its `use` steps from
      `tours/RMS-6399.tour.json`.
- [ ] Note for the per-environment task: if local and deployed RMS ever share a platform, these rules are
      `env: local` only (`"as": "fail"` elsewhere).

### Other gaps

- [ ] **Failed response bodies**: `network.json` has only the status (RMS `450` = business-logic error). Keep the
      first ~500 chars of an error response body (redacted) in network.json, report "first cause" and try-step.
- [ ] **`goto` to the current URL**: with a hash route it didn't navigate, so old UI state (an open report)
      remained. Reload when the target equals the current URL, or a `reload: true` option.
- [ ] **Slow launches**: the Angular dev server took ~8 min, past `timeoutSeconds` (420), and the session failed
      while it was still compiling. Keep waiting while the service log grows, or say "still starting; raise
      timeoutSeconds".
- [ ] **Tab state**: `"state": "checked"` on a tab throws "Not a checkbox or radio button". Add `selected`
      (aria-selected), or map `checked` to it for tabs; needed `css: forge-tab[aria-selected=true]` instead.
- [ ] **One call per session**: two concurrent try-step calls on one session interleaved. Refuse or queue while a
      call is running.
- [ ] **Git Bash path conversion**: `#/case/...` args became `C:/Program Files/Git/case/...`. Detect and undo it in
      the CLI, or document `MSYS_NO_PATHCONV=1` in AGENTS.md.
- [ ] **Finding test data**: local case search returned nothing; a SQL query found a case with field reports.
      Support data-lookup fixture hooks (a query → `{data.caseId}`) so tours don't hard-code record ids.
- [ ] **Dependent services in doctor**: the TCM container had exited 5 days earlier, which broke file storage.
      `requirements.mjs` (rms, rms-local-dev) should check the containers file storage depends on.

### For the RMS team (not this tool)

- The IBR refresh button is an icon-only `mat-icon-button` with no `aria-label`; tours need CSS to find it.
- Case Reports for a case with no field reports (2019-00000001) throws `Cannot read properties of undefined
  (reading 'length')` in `FieldReportsComponent` and stays on "Loading".

### Video: cut dead air

- [ ] **Trim waits from the video**: long loads (RMS screens settling, busy indicators, `ready` waits, slow
      responses, dismissed workaround dialogs) are filmed in full, so scenes sit still with no narration. Record
      those windows in `timings.json` (start/end, reason: `ready` / `waitFor` / `waitForResponse` / workaround) and
      cut them in `render.mjs`, keeping a short lead-in (~0.3 s) so the cut isn't jarring; narration audio is never
      cut. Option to speed up instead of cut (e.g. 4×), and a threshold so short waits stay (`video.trimWaitsOver`,
      default ~1.5 s). The report lists how much was trimmed per scene; `--no-trim` keeps the raw pacing.
