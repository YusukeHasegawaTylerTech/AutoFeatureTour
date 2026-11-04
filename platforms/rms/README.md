# Platform: RMS (local dev)

Tours of the NWPS RMS web app running locally: the Angular dev server on http://localhost:4200 in front of the
.NET services on https://localhost:6600.

```
aft doctor --platform rms
aft platform check rms                              # doctor, settings, sign in + the smoke tour (tours/smoke.tour.json)
aft generate --story examples/stories/RMS-6142.md --platform rms --llm claude --style verification
aft validate out/RMS-6142-localhost/<run>/tour.json
aft run      out/RMS-6142-localhost/<run>/tour.json
```

## Setup

| Variable | Meaning | Default |
|---|---|---|
| `AFT_RMS_USERNAME`, `AFT_RMS_PASSWORD` | RMS login, from the environment or a git-ignored `.env` in the AutoFeatureTour folder | local dev default: `dev` / `1` |
| `AFT_RMS_DEV_SCRIPTS` | the nwps-rms-dev-scripts checkout (nwps-rms-records must be its sibling) | `C:\TylerDev\nwps-rms-dev-scripts` |
| `AFT_RMS_SKIP_BUILD` | `1` passes `-SkipBuild` when the tour has to start a service | unset |

Docker Desktop and the dev-docker containers must be running (`aft doctor --platform rms` checks).

## What a run does

- **Services:** if something already answers on :6600 (API) or :4200 (web), it's used as is and never stopped or
  restarted. Otherwise `start.ps1` opens `StartRmsApi.local.ps1` / `StartWebUi.local.ps1` in their own console
  window (as the desktop shortcuts do) and waits up to 10 / 7 minutes; they stay running afterwards. `-Force` is
  never used.
- **Login:** the RMS form (`#Username`, `#passwordField`, the CJIS acknowledgment, Sign In; the same flow as the e2e
  `LoginPage` and CaptureModuleScreenshots), in a separate browser that isn't recorded or traced. The password is set
  through the DOM, never typed or logged. The session is saved to `auth/rms/local/dev.json` (git-ignored) and reused; if it
  expires, the run says so: it signs in again by itself off camera (or `aft login --platform rms [--manual]`).
- **Readiness:** the app keeps long-lived connections open, so "network idle" never happens. The tour waits for the
  splash and busy indicators (`ready.busy`) to disappear and for the page to stop changing, with up to 60 s per screen.
- **Data:** this is your local dev database. Tours should only read, or create what they need through the UI. No
  checkpoint/restore hooks are configured; DevDbCheckpoint / DevDbRestore could become `hooks.setup` /
  `hooks.teardown`, but only with your say-so.

## Files

`platform.json` (readiness, error dialog, timeouts, SSN mask, pronunciations) · `environments.json` (`local`: attach
or start with `start.ps1`) · `login.json` (role `dev`, via the `sign-in` fragment) · `fragments/sign-in.json`,
`fragments/open-report-area.json` · `tours/smoke.tour.json`, `tours/RMS-6142.tour.json` · `fixtures/` (none yet: the
dev database isn't reset by tours; any fixture that writes to it needs your say-so first).
