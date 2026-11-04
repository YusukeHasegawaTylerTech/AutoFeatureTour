# AutoFeatureTour

Narrated feature-tour videos of web apps. You write a narration script; a tour module drives the real app with
Playwright, paced to the spoken narration; the engine turns that into one video with captions. The goal (see
Roadmap) is to generate the script and tour module from a prompt plus the app's source code.

```
script.md ──► speech per scene (wav) ──► record the app, paced to each scene's narration (recording.webm + timings)
          ──► cut one clip per scene ──► mux narration (freeze last frame if needed) ──► tour.mp4 + tour.vtt
```

Slow work between scenes (seeding data, waiting for background jobs) happens off camera and is cut out.
Without `--record`, a scene uses a hand-made clip (`targets/<app>/clips/<tour>/scene-NN.mp4`) or a title card, so a
script can be previewed as narration + titles before any recording exists.

Started from AgenticFOIA's `docs/tour` (make-tour.ps1 + recorder), which is the first target here.

## Requirements

Node 22+, ffmpeg/ffprobe on PATH (`winget install Gyan.FFmpeg`), and Windows for the SAPI voice (the only speech
provider so far). Then:

```
npm install
npx playwright install chromium
```

## Usage

```
node src/cli.mjs <tour.mjs> [--record] [--out <dir>] [--clips <dir>] [--voice <name>] [--rate <-10..10>]
                 [--tail <seconds>] [--no-captions] [--<target option> <value> ...]
node src/cli.mjs --list-voices
npm test
```

Put the tour file first. Output goes to `out/<tour name>/` (git-ignored). Options the engine doesn't know are passed
to the tour as `ctx.options` (camelCased).

### AgenticFOIA

Expects the AgenticFOIA repo next to this one (or `--app-repo <path>` / `AFT_AGENTICFOIA_REPO`), plus the .NET 10 SDK,
Tesseract, and for the main tour the whisper/VAD models (the same `AGENTICFOIA_Media__*` variables the AgenticFOIA CLI
uses, or `--whisper-model`, `--vad-model`, `--tesseract`, `--detection-models`).

```
node src/cli.mjs targets/agenticfoia/main.tour.mjs --record
node src/cli.mjs targets/agenticfoia/pdf-ocr.tour.mjs --record --engine Placeholder
```

It builds the API and web app in Release (`--skip-build` reuses them), starts a private API (port 5190, data in
`out/<tour>/data`) and a web server (port 4310) serving the built SPA, the tour's helper pages and an `/api` proxy.
The default engine is `ClaudeCli` (local `claude -p`), which AgenticFOIA allows for synthetic data only.

## Writing a target

```
targets/<app>/
  scripts/<tour>.md     narration: "## N. Title", "*capture cue*" lines, then narration paragraphs
  <tour>.tour.mjs       export default { name, script, pronounce?, viewport?, voice?, async record(ctx) }
  app.mjs               launch / seed / API helpers shared by the app's tours
  pages/                optional helper pages (diagrams, comparisons) that set window.tourReady = true
```

`record(ctx)` gets `{ tour, scenes, outDir, options, toolRoot, targetDir, log, run }`. Typical shape:

```js
const page = await ctx.tour.start({ initScripts: [...] });   // starts recording
await ctx.tour.scene('scene-01', async t => {                 // one narrated scene
  await t.at(0.3);                                            // 30% of the way through its narration
  await t.click(page.locator('#add'));
});
// ...off-camera work between scenes is cut...
await ctx.tour.finish();                                      // writes recording.webm + timings.json
```

Tour helpers: `at`, `moveTo`, `click`, `typeInto`, `drag`, `helper(url)`. In `src/recorder.mjs`:
`startStaticServer` (SPA + routes + API proxy), `startProcess`, `waitForHttp`.

## Rules

- **Synthetic or demo data only.** Never point a tour at shared or production environments, or at real records.
  Each run should start the app with its own fresh data.
- Tours are plain code checked in. Rendering never depends on an LLM.

## Roadmap

- Generic `tour.yaml` launch config (command, health URL, reset script, login) so simple apps need no `app.mjs`.
- Agent layer: from a prompt plus the app's source, draft `script.md` and the scene code, run it against the app and
  repair failing steps (Claude Agent SDK with repo read tools + Playwright).
- Cross-platform speech (Piper), per-sentence captions, frame-grab review before the final render.
