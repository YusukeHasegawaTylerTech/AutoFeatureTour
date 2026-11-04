# Target: RMS (local dev)

Tours of the NWPS RMS web app running locally: the Angular dev server on http://localhost:4200 in front of the
.NET services on https://localhost:6600.

```
aft doctor --target rms
aft validate targets/rms/rms.tour.json              # sign in + home page, no recording
aft generate --story examples/stories/RMS-6142.md --tour targets/rms/rms.tour.json --llm claude --style verification
aft validate out/RMS-6142-localhost/<run>/tour.json
aft run      out/RMS-6142-localhost/<run>/tour.json
```

## Setup

| Variable | Meaning | Default |
|---|---|---|
| `AFT_RMS_USERNAME`, `AFT_RMS_PASSWORD` | RMS login, from the environment or a git-ignored `.env` in the AutoFeatureTour folder | local dev default: `dev` / `1` |
| `AFT_RMS_DEV_SCRIPTS` | the nwps-rms-dev-scripts checkout (nwps-rms-records must be its sibling) | `C:\TylerDev\nwps-rms-dev-scripts` |
| `AFT_RMS_SKIP_BUILD` | `1` passes `-SkipBuild` when the tour has to start a service | unset |

Docker Desktop and the dev-docker containers must be running (`aft doctor --target rms` checks).

## What a run does

- **Services:** if something already answers on :6600 (API) or :4200 (web), it's used as is and never stopped or
  restarted. Otherwise `start.ps1` opens `StartRmsApi.local.ps1` / `StartWebUi.local.ps1` in their own console
  window (as the desktop shortcuts do) and waits up to 10 / 7 minutes; they stay running afterwards. `-Force` is
  never used.
- **Login:** the RMS form (`#Username`, `#passwordField`, the CJIS acknowledgment, Sign In; the same flow as the e2e
  `LoginPage` and CaptureModuleScreenshots), in a separate browser that isn't recorded or traced. The password is set
  through the DOM, never typed or logged. The session is saved to `auth/rms/dev.json` (git-ignored) and reused; if it
  expires, the run says so: re-run `aft login targets/rms/rms.tour.json` (or `--manual` to sign in by hand).
- **Readiness:** the app keeps long-lived connections open, so "network idle" never happens. The tour waits for the
  splash and busy indicators (`ready.busy`) to disappear and for the page to stop changing, with up to 60 s per screen.
- **Data:** this is your local dev database. Tours should only read, or create what they need through the UI. No
  checkpoint/restore hooks are configured; DevDbCheckpoint / DevDbRestore could become `hooks.setup` /
  `hooks.teardown`, but only with your say-so.
