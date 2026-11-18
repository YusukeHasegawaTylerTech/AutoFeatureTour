import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { duration } from './render.mjs';
import { run } from './util.mjs';

// Speech providers:
//   sapi    local Windows voices (default on Windows)
//   piper   local neural voices (Piper, https://github.com/OHF-Voice/piper1-gpl): free, offline, any OS; a Python
//           package and voice models in models/piper/ (aft voices --install-piper), see piperPaths()
//   silent  a silent track as long as the narration would take to say (default elsewhere); captions carry the words
// A cloud voice would slot in here.
export const PROVIDERS = ['sapi', 'piper', 'silent'];
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
  if (provider === 'piper') return speakPiper({ text, wav, voice, rate });
  if (provider !== 'sapi') throw new Error(`Unknown speech provider "${provider}" (${PROVIDERS.join(', ')})`);
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
/** The installed voices: SAPI names ([] where there is no SAPI), or with provider "piper" the voice models' names. */
export async function listVoices({ provider = defaultProvider() } = {}) {
  if (provider === 'piper') return piperVoices();
  if (process.platform !== 'win32') return [];
  installed ??= (await ps(['-List'])).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return installed;
}

/**
 * A voice as written ("Zira", "microsoft david", the full name) → the installed voice's name. Exact match first, then
 * case-insensitive, then a unique substring. Throws, listing the installed voices, when none or several match.
 */
export async function resolveVoice(name, { provider = defaultProvider() } = {}) {
  if (provider === 'piper' && !name) return piperVoices()[0];
  if (!name || (provider !== 'sapi' && provider !== 'piper')) return name || undefined;
  const voices = await listVoices({ provider });
  const want = String(name).trim().toLowerCase();
  const hit = voices.find(v => v === name) ?? voices.find(v => v.toLowerCase() === want);
  if (hit) return hit;
  const some = voices.filter(v => v.toLowerCase().includes(want));
  if (some.length === 1) return some[0];
  const none = provider === 'piper' ? `none in ${piperPaths().voices} (aft voices --install-piper)` : 'none (add one in Windows Settings > Time & language > Speech)';
  const list = voices.length ? voices.map(v => `"${v}"`).join(', ') : none;
  throw new Error(some.length ? `voice "${name}" matches several voices: ${some.map(v => `"${v}"`).join(', ')}; be more specific`
    : `no ${provider === 'piper' ? 'Piper ' : ''}voice "${name}" is installed (installed: ${list}). aft voices${provider === 'piper' ? ' --speech piper' : ''} lists them; --speech silent needs none`);
}

// ---- Piper -----------------------------------------------------------------------------------------------------

const toolRoot = path.resolve(here, '..');
const piperScript = path.join(here, 'tts-piper.py');

/**
 * Where Piper lives: models/piper/.venv (its Python, with piper-tts and onnx) and models/piper/voices (<name>.onnx +
 * <name>.onnx.json, as `python -m piper.download_voices` writes them). models/ is git-ignored. AFT_PIPER_PYTHON and
 * AFT_PIPER_VOICES point elsewhere (a Python that already has piper-tts, a shared voices folder).
 */
export function piperPaths() {
  const home = path.join(toolRoot, 'models', 'piper');
  const venv = path.join(home, '.venv');
  const python = process.env.AFT_PIPER_PYTHON
    || (process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'));
  return { home, venv, python, voices: process.env.AFT_PIPER_VOICES || path.join(home, 'voices') };
}

/** The Piper voice models in the voices folder, by name ("en_US-ljspeech-high"), sorted. */
export function piperVoices() {
  const dir = piperPaths().voices;
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.onnx') && fs.existsSync(path.join(dir, `${f}.json`))).map(f => f.slice(0, -5)).sort();
  } catch { return []; }
}

/** SAPI's rate (-10 slow … 10 fast) as a speed for Piper: about 3× either way at the ends, as SAPI does. */
export const piperSpeed = rate => +(3 ** (Math.max(-10, Math.min(10, Number(rate) || 0)) / 10)).toFixed(3);

let piper = null; // { proc, ask(request) → answer }, one per process, started on the first scene

function startPiper() {
  const { python } = piperPaths();
  if (!fs.existsSync(python) && !process.env.AFT_PIPER_PYTHON) {
    throw new Error(`Piper speech provider: no Python at ${python}; run aft voices --install-piper (or set AFT_PIPER_PYTHON), or use --speech silent`);
  }
  const proc = spawn(python, ['-I', piperScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = [];
  let stderr = '', dead = null;
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  const fail = e => { dead = e; while (waiting.length) waiting.shift().reject(e); piper = null; };
  proc.on('error', e => fail(new Error(`Piper speech provider: couldn't start ${python}: ${e.message}`)));
  proc.on('exit', code => fail(new Error(`Piper speech provider (tts-piper.py) exited with ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}` : ''}`)));
  // Keeps the CLI alive only while an answer is awaited: idle, it never does, and when the CLI exits stdin closes and
  // the helper ends.
  const hold = on => { for (const s of [proc, proc.stdin, proc.stdout, proc.stderr]) (on ? s.ref : s.unref)?.call(s); };
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    let answer;
    try { answer = JSON.parse(line); } catch { return; } // not ours (a library printing)
    const w = waiting.shift();
    if (!w) return;
    if (!waiting.length) hold(false);
    if (answer.ok) w.resolve(answer); else w.reject(new Error(`Piper speech provider: ${answer.error}`));
  });
  const ready = new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  let chain = ready;
  const ask = request => {
    const answer = chain.then(() => new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      waiting.push({ resolve, reject });
      hold(true);
      proc.stdin.write(`${JSON.stringify(request)}\n`);
    }));
    chain = answer.catch(() => {});
    return answer;
  };
  return { proc, ask };
}

async function speakPiper({ text, wav, voice, rate }) {
  const name = voice ?? piperVoices()[0];
  if (!name) throw new Error(`Piper speech provider: no voices in ${piperPaths().voices}; run aft voices --install-piper, or use --speech silent`);
  const model = path.join(piperPaths().voices, `${name}.onnx`);
  piper ??= startPiper();
  const native = `${wav}.voice.wav`;
  try {
    const said = await piper.ask({ model, text, wav: native, speed: piperSpeed(rate) });
    await run('ffmpeg', ['-y', '-v', 'error', '-i', native, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    return { words: piperWords(text, said) };
  } finally {
    fs.rmSync(native, { force: true });
  }
}

/** The text's words ({ char, length }), as estimateWords and the voices count them. */
const textWords = text => [...text.matchAll(/\S+/g)].map(m => ({ char: m.index, length: m[0].length }));

/** Sentences of text, roughly as Piper splits them (after . ! ? and closing quotes), each { start, text }. */
function sentences(text) {
  const out = [];
  const re = /[^]*?(?:[.!?]+["')\]]*(?=\s|$)|$)/g;
  for (const m of text.matchAll(re)) if (m[0].trim()) out.push({ start: m.index, text: m[0] });
  return out;
}

/**
 * tts-piper.py's answer ({ seconds, chunks: [{ start, end, words: [start…] }] }) → [{ start, char, length }]. Piper
 * names no text positions, only where each word it said starts, sentence by sentence. When it said as many words as
 * the text has, they pair one for one; else sentence by sentence where the sentences pair, a sentence whose words
 * don't pair being spread over its own time (as estimateWords does); else the whole text is spread over the wav.
 */
export function piperWords(text, said) {
  const chunks = said?.chunks ?? [];
  const words = textWords(text);
  const starts = chunks.flatMap(c => c.words ?? []);
  if (words.length && starts.length === words.length && chunks.every(c => c.words)) {
    return words.map((w, i) => ({ start: starts[i], ...w }));
  }
  const parts = sentences(text);
  if (chunks.length > 1 && parts.length === chunks.length) {
    return parts.flatMap((p, i) => {
      const c = chunks[i], own = textWords(p.text).map(w => ({ ...w, char: w.char + p.start }));
      if (c.words?.length === own.length) return own.map((w, j) => ({ start: c.words[j], ...w }));
      return estimateWords(p.text, c.end - c.start).map(w => ({ ...w, start: +(c.start + w.start).toFixed(3), char: w.char + p.start }));
    });
  }
  return estimateWords(text, said?.seconds ?? 0);
}

/**
 * Sets Piper up in models/piper: a Python virtual environment with piper-tts and onnx (onnx: the word times), then
 * the voices (names from https://huggingface.co/rhasspy/piper-voices). Skips whatever is already there.
 * Each voice has its own licence (its MODEL_CARD): check it before using a voice outside a demo.
 */
export async function installPiper({ voices = ['en_US-ljspeech-high'], log = console.error } = {}) {
  const p = piperPaths();
  if (!fs.existsSync(p.python)) {
    const base = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
    let made = false;
    for (const [exe, pre] of base) {
      try { await run(exe, [...pre, '--version'], { capture: true }); } catch { continue; }
      log(`piper: creating ${p.venv} with ${exe}`);
      await run(exe, [...pre, '-m', 'venv', p.venv]);
      made = true;
      break;
    }
    if (!made) throw new Error('Piper needs Python 3.9+ (none found: py / python3 / python). Install it (winget install Python.Python.3.12), then run this again');
  }
  try { await run(p.python, ['-I', '-c', 'import piper, onnx'], { capture: true }); log('piper: piper-tts installed'); } catch {
    log('piper: installing piper-tts and onnx');
    await run(p.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'piper-tts', 'onnx']);
  }
  fs.mkdirSync(p.voices, { recursive: true });
  const have = new Set(piperVoices());
  for (const v of voices) {
    if (have.has(v)) { log(`piper: voice ${v} installed`); continue; }
    log(`piper: downloading voice ${v}`);
    await run(p.python, ['-I', '-m', 'piper.download_voices', v, '--data-dir', p.voices]);
  }
  return { ...p, installed: piperVoices() };
}
