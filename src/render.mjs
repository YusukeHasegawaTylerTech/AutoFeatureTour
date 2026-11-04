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

/** Cuts the recording into one clip per scene window ({ id, start, end } in seconds). */
export async function cutClips(recording, timings, clipsDir) {
  fs.mkdirSync(clipsDir, { recursive: true });
  for (const t of timings)
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', num(t.start), '-to', num(t.end), '-i', recording,
      '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', path.join(clipsDir, `${t.id}.mp4`)]);
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

/** WebVTT captions, one cue per scene covering its whole narration. */
export function writeCaptions(cues, file) {
  const ts = s => new Date(s * 1000).toISOString().slice(11, 23);
  let t = 0;
  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    out += `${ts(t)} --> ${ts(t + c.narrationSeconds)}\n${c.text}\n\n`;
    t += c.length;
  }
  fs.writeFileSync(file, out, 'utf8');
}
