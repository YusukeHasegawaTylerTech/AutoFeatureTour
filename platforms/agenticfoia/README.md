# Platform: AgenticFOIA

Platform: four code tours (`tours/`) of [AgenticFOIA](../../../AgenticFOIA) (AI-assisted redaction for public-records requests).
Every tour starts from a Mock RMS record request: start a redaction review, import the referenced records' files.

| Tour | Script | Shows |
|---|---|---|
| `main.tour.mjs` | `scripts/main.md` | start a review, review a text report, redact a body-camera video, export a PDF, the redaction log |
| `pdf-ocr.tour.mjs` | `scripts/pdf-ocr.md` | OCR of a two-page image-only scan with ID photos, review, faces, the export pipeline, the re-OCR leak check |
| `rms.tour.mjs` | `scripts/rms.md` | the record request in depth: referenced records, review, video, export, packet sign-off and write-back, the RMS seam |
| `full.tour.mjs` | `scripts/full.md` | the rms tour plus a denial, photo OCR and the scanned PDF with ID photos (OCR, a detected face, a box drawn by hand) |

```
aft run platforms/agenticfoia/tours/main.tour.mjs
aft run platforms/agenticfoia/tours/pdf-ocr.tour.mjs --face-photo <portraits.png> --engine Placeholder --skip-build
aft run platforms/agenticfoia/tours/rms.tour.mjs --engine Placeholder
aft run platforms/agenticfoia/tours/full.tour.mjs --face-photo <portraits.png>
aft doctor --platform agenticfoia
```

## Requirements

The AgenticFOIA repo next to AutoFeatureTour (or `--app-repo <path>` / `AFT_AGENTICFOIA_REPO`), the .NET 10 SDK and
Tesseract (all tours). The pdf-ocr helper pages use `pdfjs-dist` (an optional npm dependency).

Models, each taken from its flag, else the `AGENTICFOIA_Media__*` environment variable the AgenticFOIA CLI uses, else
the git-ignored default under `models/agenticfoia/` in this repo (used only if it exists):

| Model | Flag / env var | Default | Tours |
|---|---|---|---|
| whisper | `--whisper-model` / `AGENTICFOIA_Media__WhisperModel` | `models/agenticfoia/ggml-base.bin` | main, rms, full |
| Silero VAD | `--vad-model` / `AGENTICFOIA_Media__VadModel` | `models/agenticfoia/silero_vad.onnx` | main, rms, full |
| detection (YuNet, SFace, YOLOX) | `--detection-models` / `AGENTICFOIA_Media__DetectionModels` | `models/agenticfoia/detection/` | pdf-ocr, full |

`--tesseract` / `AGENTICFOIA_Media__Tesseract` point at Tesseract if it isn't on PATH or in its usual install folder.

The pdf-ocr and full tours need a scanned PDF with ID photos. `make-scan.cs --form` makes it from
`--face-photo <image with two portraits>` (read where it is, never copied), writing `014-witness-statement-scanned.pdf`
and its ground truth `form-truth.json` into the run folder. pdf-ocr requires `--face-photo`. Without it, full uses
`--scan-file` plus `--form-truth`, or else the newest pair from an earlier pdf-ocr run under `out/agenticfoia-pdf-ocr/`.

## What a run does

It builds the API and web app in Release (`--skip-build` reuses existing builds), starts a private API with its own
data folder inside the run folder, and a web server that serves the built SPA, the helper pages in `pages/` and an
`/api` proxy. Both listen on free ports (`--api-port` / `--web-port` to fix them). It seeds the Mock RMS itself: the
referenced records' files go under `<run>/data/rms-mock/records/<type>/<number>/` before the API starts, and the
requests are created with `POST /record-requests`. Only synthetic files are used: the test corpus, media from
`make-media.ps1`, and a scan made by `make-scan.cs`. The default redaction engine is `ClaudeCli` (local `claude -p`),
which AgenticFOIA allows for synthetic data only; `--engine Placeholder` avoids it.

These options reach the tour as `ctx.options`; the engine doesn't know about them.
