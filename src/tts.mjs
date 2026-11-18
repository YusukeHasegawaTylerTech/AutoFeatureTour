import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { duration } from './render.mjs';
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

/**
 * Says text into wav (48 kHz mono). Returns { words: [{ start, char, length }] }: when each word starts (seconds into
 * the wav) and where it is in text, for captions that follow the voice. SAPI reports them; for the silent provider they
 * are spread over the estimated length by word length, with a pause after punctuation.
 */
export async function speak({ text, wav, voice, rate = 0, provider = defaultProvider() }) {
  if (provider === 'silent') {
    const seconds = estimateSeconds(text);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(seconds), wav]);
    return { words: estimateWords(text, seconds) };
  }
  if (provider !== 'sapi') throw new Error(`Unknown speech provider "${provider}" (sapi, silent)`);
  if (process.platform !== 'win32') throw new Error('The sapi speech provider needs Windows; use --speech silent');
  // Next to the wav, inside this run's own folder.
  const textFile = `${wav}.txt`, native = `${wav}.voice.wav`, wordsFile = `${wav}.words.json`;
  fs.writeFileSync(textFile, text, 'utf8');
  try {
    await ps(['-TextFile', textFile, '-Wav', native, '-Words', wordsFile, '-Rate', String(rate), ...(voice ? ['-Voice', voice] : [])]);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', native, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    let said = null;
    try { said = JSON.parse(fs.readFileSync(wordsFile, 'utf8').replace(/^﻿/, '')); } catch { /* no word times: captions spread the words evenly */ }
    return { words: sapiWords(text, said, await duration(native)) };
  } finally {
    for (const f of [textFile, native, wordsFile]) fs.rmSync(f, { force: true });
  }
}

/**
 * SAPI's word events ({ end, marks: [{ t, c, n }] }, src/tts-sapi.ps1) → [{ start, char, length }] in text and in seconds
 * of the wav (seconds long). Its times run fast by a voice-dependent factor: the bookmark at the end of the text
 * ("end") is where the wav ends. Its character positions are offset by the SSML header: the first word is where the
 * text's first letter or digit is. A word said in parts ("80 percent" for "80%") repeats; the first is kept.
 */
export function sapiWords(text, said, seconds) {
  const marks = (said?.marks ?? []).filter(m => Number.isFinite(m?.t) && Number.isFinite(m?.c));
  if (!marks.length) return [];
  const scale = said.end > 0 && seconds > 0 ? seconds / said.end : 1;
  const offset = marks[0].c - Math.max(0, text.search(/[\p{L}\p{N}]/u));
  const words = [];
  for (const m of marks) {
    const char = m.c - offset;
    if (!words.some(w => w.char === char)) words.push({ start: +Math.min(seconds || Infinity, m.t * scale).toFixed(3), char, length: m.n });
  }
  return words;
}

/** Word start times spread over seconds by length (a sentence or clause end counts as a few extra characters). */
export function estimateWords(text, seconds) {
  const words = [...text.matchAll(/\S+/g)].map(m => ({ char: m.index, length: m[0].length,
    weight: m[0].length + 1 + (/[.!?]["')\]]*$/.test(m[0]) ? 6 : /[,;:]$/.test(m[0]) ? 3 : 0) }));
  const total = words.reduce((a, w) => a + w.weight, 0) || 1;
  let at = 0;
  return words.map(w => { const start = (at / total) * seconds; at += w.weight; return { start: +start.toFixed(3), char: w.char, length: w.length }; });
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
