// AgenticFOIA's own requirements, for `aft doctor` (advisory; strict with `aft doctor --target agenticfoia`).
import fs from 'node:fs';
import path from 'node:path';

export default async function requirements({ add, which, run, toolRoot }) {
  const sdks = which('dotnet') ? await run('dotnet', ['--list-sdks'], { capture: true }).catch(() => '') : '';
  add('.NET 10 SDK', /^10\./m.test(sdks), sdks.split(/\r?\n/).filter(Boolean).pop() ?? 'dotnet not found', 'winget install Microsoft.DotNet.SDK.10');
  const tess = [process.env.AGENTICFOIA_Media__Tesseract, which('tesseract'), `${process.env.ProgramFiles}\\Tesseract-OCR\\tesseract.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Tesseract-OCR\\tesseract.exe`].find(f => f && fs.existsSync(f));
  add('Tesseract', tess, tess ?? 'not found', 'winget install UB-Mannheim.TesseractOCR (or set AGENTICFOIA_Media__Tesseract)');
  const repo = process.env.AFT_AGENTICFOIA_REPO ?? path.join(toolRoot, '..', 'AgenticFOIA');
  add('repo', fs.existsSync(path.join(repo, 'AgenticFOIACompute')), repo, 'clone it next to AutoFeatureTour, or set AFT_AGENTICFOIA_REPO / pass --app-repo');
  add('pdfjs-dist (pdf-ocr helper pages)', fs.existsSync(path.join(toolRoot, 'node_modules', 'pdfjs-dist')), 'node_modules/pdfjs-dist', 'npm install (optional dependency)');
  add('claude CLI (default ClaudeCli engine)', which('claude'), which('claude') ?? 'not on PATH', 'install Claude Code, or pass --engine Placeholder', false);
  for (const k of ['WhisperModel', 'VadModel']) {
    const f = process.env[`AGENTICFOIA_Media__${k}`];
    add(`${k} (main tour)`, f && fs.existsSync(f), f ?? 'not set', `set AGENTICFOIA_Media__${k} to the model file (AgenticFOIA AGENTS.md)`, false);
  }
}
