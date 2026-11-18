// Captions: the narration as subtitle cues that follow the voice.
//
// Each scene's narration is split into cues of at most `maxLines` lines of at most `maxCharsPerLine` characters (a cue
// never spans two sentences, and the lines of a cue are balanced), each shown from its first word to the next cue.
// Word times come from the voice (tts.mjs speak(): SAPI reports when each word starts; the silent provider estimates
// them), matched to the words as written: the narration is shown as written (without "pronounce" substitutions) but
// timed as said.
//
// Modes ("video": { "captions": { "mode" } } on the platform or tour, --captions):
//   file  (default) tour_<…>.vtt beside the video, which players load with it
//   soft  that, and the same captions as a subtitle track inside the mp4 (players can turn it on and off)
//   burn  drawn into the picture (libass, via an .ass file); "highlight" colours the word being said ("word") or every
//         word said so far ("karaoke"). The .vtt is written as captions.vtt, so no player shows the words twice.
//   off   none (--no-captions)
import fs from 'node:fs';

export const CAPTION_MODES = ['file', 'soft', 'burn', 'off'];
export const HIGHLIGHTS = ['off', 'word', 'karaoke'];
export const CAPTION_DEFAULTS = { mode: 'file', maxCharsPerLine: 42, maxLines: 2, highlight: 'off', color: '#ffffff', highlightColor: '#ffd54a',
  fontSize: 46, font: 'Segoe UI', position: 'bottom', background: 0.55 };

/**
 * The caption settings for a run: the defaults, the composed "video.captions", then the command line (--captions
 * <mode>, --no-captions, --highlight [word|karaoke|off], --chars-per-line N, --caption-lines N). Throws on a bad value.
 */
export function captionSettings(video = {}, args = {}) {
  const c = { ...CAPTION_DEFAULTS, ...(video?.captions ?? {}) };
  if (args.captions !== undefined) c.mode = args.captions === true ? 'burn' : String(args.captions);
  if (args.noCaptions) c.mode = 'off';
  if (args.highlight !== undefined) c.highlight = args.highlight === true ? 'word' : String(args.highlight);
  if (args.charsPerLine !== undefined) c.maxCharsPerLine = Number(args.charsPerLine);
  if (args.captionLines !== undefined) c.maxLines = Number(args.captionLines);
  if (!CAPTION_MODES.includes(c.mode)) throw new Error(`captions: "${c.mode}" is not a mode (${CAPTION_MODES.join(', ')})`);
  if (!HIGHLIGHTS.includes(c.highlight)) throw new Error(`captions: highlight "${c.highlight}" is not one of ${HIGHLIGHTS.join(', ')}`);
  if (!Number.isInteger(c.maxCharsPerLine) || c.maxCharsPerLine < 10) throw new Error(`captions: characters per line must be a whole number, 10 or more (got ${c.maxCharsPerLine})`);
  if (!Number.isInteger(c.maxLines) || c.maxLines < 1) throw new Error(`captions: lines per caption must be a whole number, 1 or more (got ${c.maxLines})`);
  for (const k of ['color', 'highlightColor']) if (!/^#[0-9a-f]{6}$/i.test(c[k])) throw new Error(`captions: ${k} must be a colour like #ffd54a (got ${c[k]})`);
  return c;
}

/**
 * The displayed words of a narration, each with when it starts and ends (seconds into the scene's narration).
 * display: the text as shown; toSpoken(text): the same text as said (pronounce substitutions); words: the voice's
 * [{ start, char, length }] in the spoken text (may be empty: then words are spread by position); seconds: how long it is said.
 */
export function timeWords(display, toSpoken, words = [], seconds = 0) {
  const tokens = [...String(display).matchAll(/\S+/g)];
  const spokenLength = toSpoken(display).length || 1;
  const voiced = [...words].sort((a, b) => a.char - b.char);
  let last = 0;
  const out = tokens.map(m => {
    // Where this word is in the spoken text: the spoken form of everything before it.
    const at = toSpoken(display.slice(0, m.index)).length;
    const w = voiced.find(v => v.char + v.length > at) ?? voiced.at(-1);
    const start = Math.max(last, Math.min(seconds, w ? w.start : (at / spokenLength) * seconds));
    last = start;
    return { text: m[0], start };
  });
  out.forEach((w, i) => (w.end = i + 1 < out.length ? out[i + 1].start : Math.max(w.start, seconds)));
  return out;
}

const len = ws => ws.reduce((a, w, i) => a + w.text.length + (i ? 1 : 0), 0);

function wrapGreedy(ws, width) {
  const lines = [];
  let line = [];
  for (const w of ws) {
    if (line.length && len([...line, w]) > width) { lines.push(line); line = []; }
    line.push(w);
  }
  if (line.length) lines.push(line);
  return lines;
}

/** As few lines as the width allows, as even as possible (no long line over a short one). */
function wrapBalanced(ws, width) {
  const k = wrapGreedy(ws, width).length;
  for (let w = Math.ceil(len(ws) / k); w < width; w++) {
    const lines = wrapGreedy(ws, w);
    if (lines.length <= k) return lines;
  }
  return wrapGreedy(ws, width);
}

function groupWhile(ws, fits) {
  const groups = [];
  let cur = [];
  for (const w of ws) {
    if (cur.length && !fits([...cur, w])) { groups.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Timed words → cues [{ start, end, lines: [[word]] }]: sentences never share a cue; a long sentence becomes as few
 * cues as the limits allow, of even length (so the last one isn't a lone word).
 */
export function splitCues(words, { maxCharsPerLine = 42, maxLines = 2 } = {}) {
  const sentences = groupWhile(words, g => !/[.!?…]["'”’)\]]*$/.test(g.at(-2)?.text ?? ''));
  const fits = g => wrapGreedy(g, maxCharsPerLine).length <= maxLines;
  const cues = [];
  for (const s of sentences) {
    const n = groupWhile(s, fits).length;
    let groups = null;
    for (let cap = Math.ceil(len(s) / n); cap <= len(s) && !groups; cap++) {
      const g = groupWhile(s, x => fits(x) && len(x) <= cap);
      if (g.length <= n) groups = g;
    }
    for (const g of groups ?? groupWhile(s, fits)) cues.push({ lines: wrapBalanced(g, maxCharsPerLine), start: g[0].start });
  }
  cues.forEach((c, i) => (c.end = i + 1 < cues.length ? cues[i + 1].start : c.lines.at(-1).at(-1).end));
  return cues;
}

/**
 * The cues of every filmed scene, back to back: scenes [{ id, words (timeWords), length, mocked, notes }] →
 * [{ start, end, id?, lines, words, note? }] in video seconds. The first cue of a scene starts with it and has its id
 * (the UI's scene markers use it); mock and known-issue notes are cues with "note" set.
 */
export function videoCues(scenes, limits) {
  const out = [];
  let t = 0;
  for (const s of scenes) {
    const cues = splitCues(s.words ?? [], limits);
    // A scene with nothing said still gets its (empty) cue: the scene markers count them.
    if (!cues.length) out.push({ id: s.id, start: t, end: t + Math.max(0.01, s.length), lines: [] });
    cues.forEach((c, i) => out.push({ id: i ? `${s.id}.${i + 1}` : s.id, start: t + (i ? c.start : 0), end: t + c.end, lines: c.lines.map(l => l.map(w => ({ ...w, start: t + w.start, end: t + w.end }))) }));
    if (s.mocked) out.push({ note: true, start: t, end: t + s.length, text: 'Simulated data: part of this scene uses canned (mocked) responses' });
    for (const n of s.notes ?? []) out.push({ note: true, start: t + n.at, end: Math.min(t + s.length, t + n.at + 4), text: `${n.text} (environment limitation, not part of the feature)` });
    t += s.length;
  }
  return out;
}

const vttTime = s => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 23);

/** WebVTT: the cues, notes at the top of the screen ("line:5%"). */
export function writeVtt(cues, file) {
  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    if (c.note) out += `${vttTime(c.start)} --> ${vttTime(c.end)} line:5%\n${c.text}\n\n`;
    else out += `${c.id}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.lines.map(l => l.map(w => w.text).join(' ')).join('\n')}\n\n`;
  }
  fs.writeFileSync(file, out, 'utf8');
}

const assTime = s => {
  const cs = Math.round(Math.max(0, s) * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
// #rrggbb → ASS BBGGRR.
const bgr = hex => `${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
const alpha = opacity => Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255).toString(16).padStart(2, '0').toUpperCase();
// ASS has no escapes: braces start override tags and backslashes start commands.
const assText = s => String(s).replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')');

/**
 * Advanced SubStation (for burning in with ffmpeg's subtitles filter) on a size[0]×size[1] picture. With highlight,
 * each word of a cue gets its own event, from when it is said to the next word, with that word (or, karaoke, every
 * word so far) in highlightColor.
 */
export function writeAss(cues, file, settings = CAPTION_DEFAULTS, size = [1920, 1080]) {
  const c = { ...CAPTION_DEFAULTS, ...settings };
  const [w, h] = size;
  const top = c.position === 'top';
  const box = `&H${alpha(c.background)}000000`;
  const style = (name, fontSize, align, marginV) =>
    // BorderStyle 4 (libass): one box behind the whole caption in BackColour, padded by Outline (transparent here). Style 3
    // boxes each run of text, and a highlighted word's box overlapping its neighbours' shows as dark seams.
    `Style: ${name},${c.font},${fontSize},&H00${bgr(c.color)},&H00${bgr(c.highlightColor)},&HFF000000,${box},0,0,0,0,100,100,0,0,4,${Math.round(fontSize / 4)},0,${align},80,80,${marginV},1`;
  const lines = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Caption', c.fontSize, top ? 8 : 2, Math.round(h * 0.05)),
    style('Note', Math.round(c.fontSize * 0.7), top ? 2 : 8, Math.round(h * 0.04)), '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const event = (start, end, styleName, text) => { if (end - start >= 0.01) lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${text}`); };
  const lit = text => `{\\c&H${bgr(c.highlightColor)}&}${text}{\\c&H${bgr(c.color)}&}`;
  for (const cue of cues) {
    if (cue.note) { event(cue.start, cue.end, 'Note', assText(cue.text)); continue; }
    const draw = on => cue.lines.map(l => l.map(x => (on(x) ? lit(assText(x.text)) : assText(x.text))).join(' ')).join('\\N');
    if (c.highlight === 'off') { event(cue.start, cue.end, 'Caption', draw(() => false)); continue; }
    const all = cue.lines.flat();
    all.forEach((x, i) => event(i ? x.start : cue.start, i + 1 < all.length ? all[i + 1].start : cue.end, 'Caption',
      draw(y => (c.highlight === 'karaoke' ? all.indexOf(y) <= i : y === x))));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}
