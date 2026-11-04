import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';

// Speech providers. Only local Windows SAPI for now; Piper (local, cross-platform) or a cloud voice would go here.
const here = path.dirname(fileURLToPath(import.meta.url));
const sapi = path.join(here, 'tts-sapi.ps1');
const ps = args => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sapi, ...args], { capture: true });

export async function speak({ text, wav, voice, rate = 0, provider = 'sapi' }) {
  if (provider !== 'sapi') throw new Error(`Unknown speech provider "${provider}"`);
  if (process.platform !== 'win32') throw new Error('The sapi speech provider needs Windows');
  const textFile = `${wav}.txt`;
  fs.writeFileSync(textFile, text, 'utf8');
  try {
    await ps(['-TextFile', textFile, '-Wav', wav, '-Rate', String(rate), ...(voice ? ['-Voice', voice] : [])]);
  } finally {
    fs.rmSync(textFile, { force: true });
  }
}

export async function listVoices() {
  return (await ps(['-List'])).split(/\r?\n/).filter(Boolean);
}
