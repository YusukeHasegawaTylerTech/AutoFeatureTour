# Target: AgenticFOIA

Two code tours of [AgenticFOIA](../../../AgenticFOIA) (AI-assisted redaction for public-records requests):

| Tour | Script | Shows |
|---|---|---|
| `main.tour.mjs` | `scripts/main.md` | upload a request, review a text report, redact a body-camera video, export a PDF, the redaction log |
| `pdf-ocr.tour.mjs` | `scripts/pdf-ocr.md` | OCR of an image-only scan, review, the export pipeline, the re-OCR leak check |

```
aft run targets/agenticfoia/main.tour.mjs
aft run targets/agenticfoia/pdf-ocr.tour.mjs --engine Placeholder --skip-build
aft doctor --target agenticfoia
```

## Requirements

The AgenticFOIA repo next to AutoFeatureTour (or `--app-repo <path>` / `AFT_AGENTICFOIA_REPO`), the .NET 10 SDK and
Tesseract. The main tour also needs the whisper and Silero VAD models, from the same `AGENTICFOIA_Media__*`
environment variables the AgenticFOIA CLI uses, or `--whisper-model`, `--vad-model`, `--tesseract`,
`--detection-models`. The pdf-ocr helper pages use `pdfjs-dist` (an optional npm dependency).

## What a run does

It builds the API and web app in Release (`--skip-build` reuses existing builds), starts a private API with its own
data folder inside the run folder, and a web server that serves the built SPA, the helper pages in `pages/` and an
`/api` proxy. Both listen on free ports (`--api-port` / `--web-port` to fix them). It uploads synthetic files only:
the test corpus, media from `make-media.ps1`, and a scan made by `make-scan.cs`. The default redaction engine is
`ClaudeCli` (local `claude -p`), which AgenticFOIA allows for synthetic data only; `--engine Placeholder` avoids it.

These options reach the tour as `ctx.options`; the engine doesn't know about them.
