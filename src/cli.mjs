#!/usr/bin/env node
// AutoFeatureTour: builds a narrated tour video from a tour module.
//
//   node src/cli.mjs <tour.mjs> [--record] [--out <dir>] [--clips <dir>] [--voice <name>] [--rate <-10..10>]
//                    [--tail <seconds>] [--no-captions] [--<target option> <value> ...]
//   node src/cli.mjs --list-voices
//
// For each "## N. Title" scene in the tour's script:
//   1. speaks the narration into <out>/scene-NN.wav (first, so the recording can be paced to it);
//   2. with --record, calls the tour's record(ctx), which drives the app with ctx.tour and writes recording.webm and
//      timings.json, then cuts one clip per scene; without --record, uses <clips>/scene-NN.mp4 when present
//      (a hand-made screen capture, say) or a title card;
//   3. muxes the narration onto each clip, freezing the last frame if the narration runs longer.
// Then joins the scenes into <out>/tour.mp4 with captions in tour.vtt.
//
// A tour module default-exports { name, script, pronounce?, viewport?, record?(ctx) }; see targets/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Tour } from './recorder.mjs';
import { concat, cutClips, duration, muxScene, requireFfmpeg, writeCaptions } from './render.mjs';
import { parseScript, spokenText } from './script.mjs';
import { listVoices, speak } from './tts.mjs';
import { log, num, parseArgs, run } from './util.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_OPTIONS = new Set(['_', 'record', 'out', 'clips', 'voice', 'rate', 'tail', 'noCaptions', 'listVoices']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.listVoices) { console.log((await listVoices()).join('\n')); return; }
  const modulePath = args._[0];
  if (!modulePath) throw new Error('Usage: node src/cli.mjs <tour.mjs> [--record] [options]');
  const tourFile = path.resolve(modulePath);
  const def = (await import(pathToFileURL(tourFile).href)).default;
  const name = def.name ?? path.basename(tourFile).replace(/\.tour\.mjs$|\.mjs$/, '');
  const options = Object.fromEntries(Object.entries(args).filter(([k]) => !ENGINE_OPTIONS.has(k)));

  const outDir = path.resolve(args.out ?? path.join(toolRoot, 'out', name));
  const clipsDir = path.resolve(args.clips ?? (args.record ? path.join(outDir, 'clips') : path.join(path.dirname(tourFile), 'clips', name)));
  const tail = args.tail !== undefined ? Number(args.tail) : 0.75;
  const rate = args.rate !== undefined ? Number(args.rate) : 0;
  fs.mkdirSync(outDir, { recursive: true });
  requireFfmpeg();

  // 1. Narration.
  const scenes = parseScript(path.resolve(path.dirname(tourFile), def.script));
  for (const s of scenes) {
    s.wav = path.join(outDir, `${s.id}.wav`);
    await speak({ text: spokenText(s.narration, def.pronounce), wav: s.wav, voice: args.voice ?? def.voice, rate });
    s.narrationSeconds = await duration(s.wav);
    s.seconds = s.narrationSeconds + tail;
  }
  log(`narration: ${scenes.length} scenes, ${num(scenes.reduce((a, s) => a + s.seconds, 0))} s`);

  // 2. Recording.
  if (args.record) {
    if (!def.record) throw new Error(`${name} has no record(ctx); run without --record to use clips or title cards`);
    const tour = new Tour({ outDir, viewport: def.viewport, narration: scenes.map(s => ({ id: s.id, seconds: s.seconds })) });
    const ctx = { tour, scenes, outDir, options, toolRoot, targetDir: path.dirname(tourFile), log, run };
    try { await def.record(ctx); } finally { await tour.close(); }
    const timings = JSON.parse(fs.readFileSync(path.join(outDir, 'timings.json'), 'utf8')).scenes;
    await cutClips(path.join(outDir, 'recording.webm'), timings, clipsDir);
  }

  // 3. Mux and join.
  const segments = [];
  for (const s of scenes) {
    const seg = await muxScene({ scene: s, clip: path.join(clipsDir, `${s.id}.mp4`), outDir });
    segments.push(seg.file);
    s.length = seg.length;
  }
  const file = await concat(segments, outDir);
  if (!args.noCaptions)
    writeCaptions(scenes.map(s => ({ text: spokenText(s.narration), narrationSeconds: s.narrationSeconds, length: s.length })), path.join(outDir, 'tour.vtt'));
  console.log(`Done: ${file}  (${num(await duration(file))} s)`);
}

main().catch(e => { console.error(e); process.exit(1); });
