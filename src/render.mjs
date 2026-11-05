import fs from 'node:fs';
import path from 'node:path';
import { num, run, which } from './util.mjs';

export function requireFfmpeg() {
  for (const tool of ['ffmpeg', 'ffprobe'])
    if (!which(tool)) throw new Error(`${tool} not found on PATH (winget install Gyan.FFmpeg)`);
}

export async function duration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { capture: true });
  return parseFloat(out.trim().split(/\r?\n/)[0]);
}

/**
 * Which parts of a scene's waits ({ start, end, reason } in recording seconds, from timings.json) to cut or speed up:
 * waits longer than "over" seconds, minus a short lead-in so the cut isn't jarring. Overlapping waits are merged.
 * Returns { windows: [{ start, end }], saved (seconds removed), map(t): where recording time t lands in the trimmed
 * scene, as recording-relative seconds (start + offset) }.
 */
export function trimPlan(scene, { mode = 'cut', over = 1.5, speed = 4, leadIn = 0.3 } = {}) {
  const none = { mode, windows: [], saved: 0, map: t => t };
  if (!scene.waits?.length) return none;
  const merge = list => {
    const merged = [];
    for (const w of [...list].sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1];
      if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
      else merged.push({ start: w.start, end: w.end });
    }
    return merged;
  };
  const clip = w => ({ ...w, start: Math.max(scene.start, w.start), end: Math.min(scene.end, w.end) });
  // Off-camera steps ("camera": false) are always cut, whole, whatever the mode: they are not part of the video.
  const forced = merge(scene.waits.filter(w => w.reason === 'offCamera')).map(w => clip({ ...w, drop: true })).filter(w => w.end - w.start > 0.05);
  const outside = w => !forced.some(f => w.start < f.end && w.end > f.start);
  const waits = mode === 'off' ? [] : merge(scene.waits.filter(w => w.reason !== 'offCamera')).filter(w => w.end - w.start > over)
    .map(w => clip({ start: w.start + leadIn, end: w.end })).filter(w => w.end - w.start > 0.05 && outside(w));
  const windows = [...forced, ...waits].sort((a, b) => a.start - b.start);
  if (!windows.length) return none;
  // The fraction of each window that stays.
  const keep = w => (w.drop || mode !== 'speed' ? 0 : 1 / speed);
  const saved = windows.reduce((s, w) => s + (w.end - w.start) * (1 - keep(w)), 0);
  const map = t => {
    let shift = 0;
    for (const w of windows) {
      if (t >= w.end) shift += (w.end - w.start) * (1 - keep(w));
      else if (t > w.start) shift += (t - w.start) * (1 - keep(w));
    }
    return t - shift;
  };
  return { mode, windows, saved, map, speed };
}

/**
 * Cuts the recording into one clip per scene window ({ id, start, end } in seconds). With t.trim (see trimPlan), the
 * scene's long waits are left out ("cut") or played faster ("speed").
 */
export async function cutClips(recording, timings, clipsDir) {
  fs.mkdirSync(clipsDir, { recursive: true });
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
  for (const t of timings) {
    const out = path.join(clipsDir, `${t.id}.mp4`);
    const windows = t.trim?.windows ?? [];
    if (!windows.length) {
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', num(t.start), '-to', num(t.end), '-i', recording, ...enc, out]);
      continue;
    }
    // Pieces in clip time (the input starts at t.start): kept parts at normal speed, windows dropped or sped up.
    const pieces = [];
    let at = t.start;
    for (const w of windows) {
      if (w.start > at) pieces.push({ a: at - t.start, b: w.start - t.start, f: 1 });
      if (t.trim.mode === 'speed' && !w.drop) pieces.push({ a: w.start - t.start, b: w.end - t.start, f: t.trim.speed });
      at = w.end;
    }
    if (t.end > at) pieces.push({ a: at - t.start, b: t.end - t.start, f: 1 });
    const filter = [`[0:v]split=${pieces.length}${pieces.map((_, i) => `[s${i}]`).join('')}`,
      ...pieces.map((p, i) => `[s${i}]trim=start=${num(p.a)}:end=${num(p.b)},setpts=(PTS-STARTPTS)/${p.f}[p${i}]`),
      `${pieces.map((_, i) => `[p${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[v]`].join(';');
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', num(t.start), '-to', num(t.end), '-i', recording, '-filter_complex', filter, '-map', '[v]', ...enc, out]);
  }
}

const FONT = ['C:/Windows/Fonts/segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc']
  .find(f => fs.existsSync(f));

/**
 * Puts a scene's narration over its clip (freezing the last frame if the narration is longer), or over a title card
 * when there is no clip. Every segment gets identical encoding so concat can join them without re-encoding.
 * scene.seconds is the narration length plus the tail. Returns the segment's file name (in outDir).
 */
export async function muxScene({ scene, clip, outDir, size = [1920, 1080], background = '0x1b2a41' }) {
  const [w, h] = size;
  const common = `scale=${w}:${h}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
  let length, inputs, video;
  if (clip && fs.existsSync(clip)) {
    length = Math.max(await duration(clip), scene.seconds);
    inputs = ['-i', clip];
    video = `[0:v]${common},tpad=stop_mode=clone:stop_duration=${num(length)}[v]`;
    console.log(`${scene.id}  clip + narration  ${num(length)}s`);
  } else {
    length = scene.seconds;
    fs.writeFileSync(path.join(outDir, `${scene.id}.txt`), `${scene.number}. ${scene.title}`, 'utf8');
    inputs = ['-f', 'lavfi', '-i', `color=c=${background}:s=${w}x${h}:r=30:d=${num(length)}`];
    // A relative textfile (ffmpeg runs in outDir) and an escaped drive colon keep the filter parseable.
    const font = FONT ? `fontfile='${FONT.replace(':', '\\:')}':` : '';
    video = `[0:v]drawtext=${font}textfile=${scene.id}.txt:fontcolor=white:fontsize=72:x=(w-tw)/2:y=(h-th)/2,${common}[v]`;
    console.log(`${scene.id}  title card  ${num(length)}s`);
  }
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-i', scene.wav,
    '-filter_complex', `${video};[1:a]aresample=48000,aformat=channel_layouts=stereo,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-t', num(length),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', `${scene.id}.mp4`], { cwd: outDir });
  return { file: `${scene.id}.mp4`, length };
}

export async function concat(segments, outDir, name = 'tour.mp4') {
  const list = path.join(outDir, 'concat.txt');
  fs.writeFileSync(list, segments.map(s => `file '${s}'`).join('\n'), 'utf8');
  const file = path.join(outDir, name);
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file]);
  return file;
}

/**
 * WebVTT captions, one cue per scene covering its whole narration. Scenes a mock answered in also get a
 * "Simulated data" cue at the top of the screen for the whole scene; tolerated known issues on screen (notes: { at,
 * text }, seconds into the scene) get a short cue there too.
 */
export function writeCaptions(cues, file) {
  const ts = s => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 23);
  let t = 0;
  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    out += `${ts(t)} --> ${ts(t + c.narrationSeconds)}\n${c.text}\n\n`;
    if (c.mocked) out += `${ts(t)} --> ${ts(t + c.length)} line:5%\nSimulated data: part of this scene uses canned (mocked) responses\n\n`;
    for (const n of c.notes ?? []) out += `${ts(t + n.at)} --> ${ts(Math.min(t + c.length, t + n.at + 4))} line:5%\n${n.text} (environment limitation, not part of the feature)\n\n`;
    t += c.length;
  }
  fs.writeFileSync(file, out, 'utf8');
}
