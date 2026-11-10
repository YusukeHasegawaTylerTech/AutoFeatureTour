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

let installed = null;
/** The installed voices (SAPI names); [] where there is no SAPI. */
export async function listVoices() {
  if (process.platform !== 'win32') return [];
  installed ??= (await ps(['-List'])).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return installed;
}

/**
 * A voice as written ("Zira", "microsoft david", the full name) → the installed voice's name. Exact match first, then
 * case-insensitive, then a unique substring. Throws, listing the installed voices, when none or several match.
 */
export async function resolveVoice(name, { provider = defaultProvider() } = {}) {
  if (!name || provider !== 'sapi') return name || undefined;
  const voices = await listVoices();
  const want = String(name).trim().toLowerCase();
  const hit = voices.find(v => v === name) ?? voices.find(v => v.toLowerCase() === want);
  if (hit) return hit;
  const some = voices.filter(v => v.toLowerCase().includes(want));
  if (some.length === 1) return some[0];
  const list = voices.length ? voices.map(v => `"${v}"`).join(', ') : 'none (add one in Windows Settings > Time & language > Speech)';
  throw new Error(some.length ? `voice "${name}" matches several voices: ${some.map(v => `"${v}"`).join(', ')}; be more specific`
    : `no voice "${name}" is installed (installed: ${list}). aft voices lists them; --speech silent needs none`);
}
