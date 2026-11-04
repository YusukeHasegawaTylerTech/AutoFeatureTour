import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';

// Speech providers:
//   sapi    local Windows voices (default on Windows)
//   silent  a silent track as long as the narration would take to say (default elsewhere); captions carry the words
// Piper (local, cross-platform) or a cloud voice would slot in here.
const here = path.dirname(fileURLToPath(import.meta.url));
const sapi = path.join(here, 'tts-sapi.ps1');
const ps = args => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sapi, ...args], { capture: true });

export const defaultProvider = () => (process.platform === 'win32' ? 'sapi' : 'silent');

/** Seconds a narrator takes to say text (about 150 words a minute), used for the silent provider. */
export const estimateSeconds = text => Math.max(2, text.split(/\s+/).filter(Boolean).length / 2.5);

export async function speak({ text, wav, voice, rate = 0, provider = defaultProvider() }) {
  if (provider === 'silent') {
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(estimateSeconds(text)), wav]);
    return;
  }
  if (provider !== 'sapi') throw new Error(`Unknown speech provider "${provider}" (sapi, silent)`);
  if (process.platform !== 'win32') throw new Error('The sapi speech provider needs Windows; use --speech silent');
  const textFile = `${wav}.txt`; // next to the wav, inside this run's own folder
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
