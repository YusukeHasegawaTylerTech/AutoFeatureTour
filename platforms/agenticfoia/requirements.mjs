// AgenticFOIA's own requirements, for `aft doctor` (advisory; strict with `aft doctor --platform agenticfoia`).
import fs from 'node:fs';
import path from 'node:path';

export default async function requirements({ add, which, run, toolRoot }) {
  const sdks = which('dotnet') ? await run('dotnet', ['--list-sdks'], { capture: true }).catch(() => '') : '';
  add('.NET 10 SDK', /^10\./m.test(sdks), sdks.split(/\r?\n/).filter(Boolean).pop() ?? 'dotnet not found', 'winget install Microsoft.DotNet.SDK.10');
  const tess = [process.env.AGENTICFOIA_Media__Tesseract, which('tesseract'), `${process.env.ProgramFiles}\\Tesseract-OCR\\tesseract.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Tesseract-OCR\\tesseract.exe`].find(f => f && fs.existsSync(f));
  add('Tesseract (all tours)', tess, tess ?? 'not found', 'winget install UB-Mannheim.TesseractOCR (or set AGENTICFOIA_Media__Tesseract)');
  const repo = process.env.AFT_AGENTICFOIA_REPO ?? path.join(toolRoot, '..', 'AgenticFOIA');
  add('repo', fs.existsSync(path.join(repo, 'AgenticFOIACompute')), repo, 'clone it next to AutoFeatureTour, or set AFT_AGENTICFOIA_REPO / pass --app-repo');
  add('pdfjs-dist (pdf-ocr helper pages)', fs.existsSync(path.join(toolRoot, 'node_modules', 'pdfjs-dist')), 'node_modules/pdfjs-dist', 'npm install (optional dependency)');
  add('claude CLI (default ClaudeCli engine)', which('claude'), which('claude') ?? 'not on PATH', 'install Claude Code, or pass --engine Placeholder', false);
  // Models: the env var, else the git-ignored default under models/agenticfoia/ (the same order as app.mjs settings()).
  const local = name => path.join(toolRoot, 'models', 'agenticfoia', name);
  for (const [k, file, tours] of [['WhisperModel', 'ggml-base.bin', 'main, rms, full'], ['VadModel', 'silero_vad.onnx', 'main, rms, full'],
    ['DetectionModels', 'detection', 'pdf-ocr, full']]) {
    const f = process.env[`AGENTICFOIA_Media__${k}`] ?? (fs.existsSync(local(file)) ? local(file) : undefined);
    add(`${k} (${tours} tours)`, f && fs.existsSync(f), f ?? 'not set', `put it at models/agenticfoia/${file}, or set AGENTICFOIA_Media__${k} (AgenticFOIA AGENTS.md)`, false);
  }
}
