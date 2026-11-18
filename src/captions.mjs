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
//   burn  drawn into the picture (libass, via an .ass file); "highlight" colours the word being said ("word"), every
//         word said so far ("karaoke"), or puts a box behind the word being said ("box"); "activeScale" makes that word
//         pop (it grows over popIn ms, and shrinks back over popOut ms when the next word takes over). The .vtt is
//         written as captions.vtt, so no player shows the words twice.
//   off   none (--no-captions)
//
// "preset" (--caption-style) fills in a whole look at once, e.g. short-form "creator" captions (a few words, upper
// case, a heavy outline, the spoken word popping); any key set beside it wins.
import fs from 'node:fs';

export const CAPTION_MODES = ['file', 'soft', 'burn', 'off'];
export const HIGHLIGHTS = ['off', 'word', 'karaoke', 'box'];
export const CAPTION_DEFAULTS = { mode: 'file', maxCharsPerLine: 42, maxLines: 2, maxWords: 0, minSeconds: 0, maxSeconds: 0,
  highlight: 'off', color: '#ffffff', highlightColor: '#ffd54a', boxTextColor: '#000000', activeScale: 1, popIn: 80, popOut: 120,
  fontSize: 46, font: 'Segoe UI', bold: false, uppercase: false, spacing: 0, outline: 0, outlineColor: '#000000', shadow: 0,
  position: 'bottom', margin: 0.05, background: 0.55 };

// Short-form looks (sizes on the 1920×1080 picture): burned in, a cue is 2–6 words on at most 2 lines of 22
// characters, on screen 0.8–2.5 s, upper case, white with a black outline, the spoken word popping 1.15×.
const CREATOR = { mode: 'burn', maxCharsPerLine: 22, maxLines: 2, maxWords: 6, minSeconds: 0.8, maxSeconds: 2.5, uppercase: true,
  font: 'Segoe UI Black', fontSize: 72, spacing: 1, outline: 5, shadow: 3, background: 0, margin: 0.07,
  highlight: 'word', highlightColor: '#ffd400', activeScale: 1.15, popIn: 80, popOut: 120 };
export const CAPTION_PRESETS = {
  classic: {},                                                                            // the defaults: sentence captions in a box
  bold: CREATOR,                                                                        // the spoken word turns yellow and pops
  outline: { ...CREATOR, outline: 6, shadow: 0 },                                          // the same with a heavier outline, no shadow
  box: { ...CREATOR, highlight: 'box', activeScale: 1.25, boxTextColor: '#000000' },  // a yellow box behind the word, black text
};

/**
 * The caption settings for a run: the defaults, the preset (--caption-style, else "preset"), the composed
 * "video.captions", then the command line (--captions <mode>, --no-captions, --highlight [word|karaoke|box|off],
 * --chars-per-line N, --caption-lines N, --caption-words N). Throws on a bad value.
 */
export function captionSettings(video = {}, args = {}) {
  const { preset: named, ...own } = video?.captions ?? {};
  const preset = args.captionStyle !== undefined ? String(args.captionStyle) : named ?? 'classic';
  if (!Object.hasOwn(CAPTION_PRESETS, preset)) throw new Error(`captions: "${preset}" is not a caption style (${Object.keys(CAPTION_PRESETS).join(', ')})`);
  const c = { ...CAPTION_DEFAULTS, ...CAPTION_PRESETS[preset], ...own, preset };
  if (args.captionWords !== undefined) c.maxWords = Number(args.captionWords);
  if (args.captions !== undefined) c.mode = args.captions === true ? 'burn' : String(args.captions);
  if (args.noCaptions) c.mode = 'off';
  if (args.highlight !== undefined) c.highlight = args.highlight === true ? 'word' : String(args.highlight);
  if (args.charsPerLine !== undefined) c.maxCharsPerLine = Number(args.charsPerLine);
  if (args.captionLines !== undefined) c.maxLines = Number(args.captionLines);
  if (!CAPTION_MODES.includes(c.mode)) throw new Error(`captions: "${c.mode}" is not a mode (${CAPTION_MODES.join(', ')})`);
  if (!HIGHLIGHTS.includes(c.highlight)) throw new Error(`captions: highlight "${c.highlight}" is not one of ${HIGHLIGHTS.join(', ')}`);
  if (!Number.isInteger(c.maxCharsPerLine) || c.maxCharsPerLine < 10) throw new Error(`captions: characters per line must be a whole number, 10 or more (got ${c.maxCharsPerLine})`);
  if (!Number.isInteger(c.maxLines) || c.maxLines < 1) throw new Error(`captions: lines per caption must be a whole number, 1 or more (got ${c.maxLines})`);
  if (!Number.isInteger(c.maxWords) || c.maxWords < 0) throw new Error(`captions: words per caption must be a whole number, 0 (no limit) or more (got ${c.maxWords})`);
  for (const k of ['minSeconds', 'maxSeconds', 'outline', 'shadow', 'popIn', 'popOut', 'fontSize']) if (!(Number(c[k]) >= 0)) throw new Error(`captions: ${k} must be a number, 0 or more (got ${c[k]})`);
  if (c.maxSeconds && c.minSeconds > c.maxSeconds) throw new Error(`captions: minSeconds (${c.minSeconds}) is more than maxSeconds (${c.maxSeconds})`);
  if (!(c.activeScale >= 0.5 && c.activeScale <= 3)) throw new Error(`captions: activeScale must be between 0.5 and 3 (got ${c.activeScale})`);
  if (!(c.margin >= 0 && c.margin < 0.5)) throw new Error(`captions: margin is a fraction of the picture's height, 0 to 0.5 (got ${c.margin})`);
  for (const k of ['color', 'highlightColor', 'boxTextColor', 'outlineColor']) if (!/^#[0-9a-f]{6}$/i.test(c[k])) throw new Error(`captions: ${k} must be a colour like #ffd54a (got ${c[k]})`);
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

// Words a caption shouldn't end on: the phrase goes on in the next one ("the | configuration", "because | it").
const OPEN_ENDED = new Set(('a an the to of in on at for with by from into onto about as and or but nor so if than that which who whom whose ' +
  'because while when where until unless although though after before since my your his her its our their this these those ' +
  'is are was were be been am will would can could should must may might has have had do does did not no i we you they he she it').split(' '));
const bare = w => w.text.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');

/**
 * Words → groups that fit, the cheapest overall: each group costs `group` plus its length squared (even groups are
 * cheaper), a break after a comma or similar earns `comma`, one after a word that leaves the phrase open costs `open`,
 * a lone word in a group of its own (not the whole of it) costs `lone`. Cues: a cheap group, so a caption more is
 * worth it to break in the right place. Lines: as few as fit (a dear group), then the best breaks.
 */
function phrases(s, fits, { group, open, comma, lone = 0 }) {
  const best = [{ cost: 0 }];
  for (let j = 1; j <= s.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const g = s.slice(i, j);
      if (!fits(g) && j - i > 1) break; // a longer group only fits less (a lone word always goes)
      if (!best[i]) continue;
      const last = g.at(-1);
      const end = j === s.length ? 0 : /[,;:—–]$/.test(last.text) ? comma : OPEN_ENDED.has(bare(last)) ? open : 0;
      const cost = best[i].cost + group + len(g) ** 2 + end + (g.length === 1 && s.length > 1 ? lone : 0);
      if (!best[j] || cost < best[j].cost) best[j] = { cost, from: i };
    }
  }
  const groups = [];
  for (let j = s.length; j > 0; j = best[j].from) groups.unshift(s.slice(best[j].from, j));
  return groups;
}
const CUE_BREAKS = { group: 3000, open: 2500, comma: -500, lone: 1500 };
const LINE_BREAKS = { group: 1e6, open: 300, comma: -200 };
/** As few lines as the width allows, even, broken between phrases where that's possible. */
const wrapPhrases = (ws, width) => phrases(ws, g => len(g) <= width, LINE_BREAKS);

// How long a group of words takes to say: to its last word's end, but a pause after the last word (a word's "end" runs
// to the next word) counts for half a second at most.
const saying = g => Math.min(g.at(-1).end, g.at(-1).start + 0.5) - g[0].start;

/**
 * Timed words → cues [{ start, end, lines: [[word]] }]: sentences never share a cue; a long sentence becomes as few
 * cues as the limits allow, of even length (so the last one isn't a lone word). Limits: maxCharsPerLine × maxLines;
 * maxWords (0: none); maxSeconds (0: none): a cue is split while it takes longer to say, and leaves the screen then
 * rather than staying through a pause; minSeconds: a cue on screen for less is joined to the next one of its sentence
 * when the two still fit, and the last cue of a narration stays that long.
 */
export function splitCues(words, { maxCharsPerLine = 42, maxLines = 2, maxWords = 0, minSeconds = 0, maxSeconds = 0 } = {}) {
  const sentences = groupWhile(words, g => !/[.!?…]["'”’)\]]*$/.test(g.at(-2)?.text ?? ''));
  const fitsText = g => wrapGreedy(g, maxCharsPerLine).length <= maxLines && (!maxWords || g.length <= maxWords);
  const fits = g => fitsText(g) && (!maxSeconds || g.length === 1 || saying(g) <= maxSeconds);
  const cues = [];
  for (const s of sentences) {
    let groups = phrases(s, fits, CUE_BREAKS);
    // On screen too briefly (until the next cue starts): joined to the next one.
    if (minSeconds) for (let i = 0; i + 1 < groups.length; i++) {
      if (groups[i + 1][0].start - groups[i][0].start < minSeconds && fitsText([...groups[i], ...groups[i + 1]])) {
        groups.splice(i, 2, [...groups[i], ...groups[i + 1]]);
        i--;
      }
    }
    for (const g of groups) cues.push({ lines: wrapPhrases(g, maxCharsPerLine), start: g[0].start });
  }
  cues.forEach((c, i) => {
    const last = c.lines.at(-1).at(-1);
    c.end = i + 1 < cues.length ? cues[i + 1].start : last.end;
    // Gone after maxSeconds (but never before its last word has been said), and the last one stays minSeconds.
    if (maxSeconds) c.end = Math.min(c.end, Math.max(c.start + maxSeconds, last.start + 0.5));
    if (minSeconds && i + 1 === cues.length) c.end = Math.max(c.end, c.start + minSeconds);
  });
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
    cues.forEach((c, i) => out.push({ id: i ? `${s.id}.${i + 1}` : s.id, start: t + (i ? c.start : 0), end: t + Math.min(c.end, Math.max(s.length, c.lines.at(-1).at(-1).end)), lines: c.lines.map(l => l.map(w => ({ ...w, start: t + w.start, end: t + w.end }))) }));
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
 * each word of a cue gets its own event, from when it is said to the next word: that word (karaoke: every word so far)
 * in highlightColor, or ("box") in boxTextColor on a box of highlightColor. The box is a layer underneath with the same
 * text in the same places, all of it transparent but that word's box. activeScale grows the word being said over popIn
 * ms, and the word before it shrinks back over popOut ms. outline > 0: outlined (and shadowed) text instead of a box
 * behind the caption.
 */
export function writeAss(cues, file, settings = CAPTION_DEFAULTS, size = [1920, 1080]) {
  const c = { ...CAPTION_DEFAULTS, ...settings };
  const [w, h] = size;
  const top = c.position === 'top';
  const style = (name, fontSize, align, marginV, border = c.outline > 0 ? 1 : 4) => {
    // BorderStyle 4 (libass): one box behind the whole caption in BackColour, padded by Outline (transparent here). Style 3
    // boxes each run of text (a highlighted word's box overlapping its neighbours' shows as dark seams, so it is only
    // used for the "box" layer, where just one word's box is drawn). BorderStyle 1: an outline in OutlineColour and a
    // shadow in BackColour.
    const [outlineColour, back, outline, shadow] =
      border === 1 ? [`&H00${bgr(c.outlineColor)}`, '&H60000000', c.outline, c.shadow]
      : border === 3 ? [`&H00${bgr(c.highlightColor)}`, '&HFF000000', Math.round(fontSize * 0.06), 0]
      : ['&HFF000000', `&H${alpha(c.background)}000000`, Math.round(fontSize / 4), 0];
    return `Style: ${name},${c.font},${fontSize},&H00${bgr(c.color)},&H00${bgr(c.highlightColor)},${outlineColour},${back},${c.bold ? -1 : 0},0,0,0,100,100,${c.spacing},0,${border},${outline},${shadow},${align},80,80,${marginV},1`;
  };
  const marginV = Math.round(h * c.margin), align = top ? 8 : 2;
  const lines = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Caption', c.fontSize, align, marginV),
    ...(c.highlight === 'box' ? [style('CaptionBox', c.fontSize, align, marginV, 3)] : []),
    style('Note', Math.round(c.fontSize * 0.7), top ? 2 : 8, Math.round(h * 0.04)), '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const event = (layer, start, end, styleName, text) => { if (end - start >= 0.01) lines.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${text}`); };
  const show = x => assText(c.uppercase ? x.text.toUpperCase() : x.text);
  const pop = c.activeScale !== 1, scale = Math.round(c.activeScale * 100);
  // One word's override tags (or none) and what puts the text back after it.
  const tags = (x, { box, lit, active, previous, t0 }) => {
    // On its box the word needs no outline (dark text in a dark outline is a blob).
    let t = box ? (active ? '\\3a&H00&' : '') : !lit ? '' : c.highlight === 'box' ? `\\c&H${bgr(c.boxTextColor)}&\\bord0\\shad0` : `\\c&H${bgr(c.highlightColor)}&`;
    if (pop && active) {
      const at = Math.max(0, Math.round((x.start - t0) * 1000));
      t += `\\fscx100\\fscy100\\t(${at},${at + c.popIn},\\fscx${scale}\\fscy${scale})`;
    } else if (pop && previous) t += `\\fscx${scale}\\fscy${scale}\\t(0,${c.popOut},\\fscx100\\fscy100)`;
    return t;
  };
  const after = box => `{${box ? '\\3a&HFF&' : `\\c&H${bgr(c.color)}&${c.highlight === 'box' ? '\\r' : ''}`}${pop ? '\\fscx100\\fscy100' : ''}}`;
  const draw = (cue, opts, box = false) => (box ? '{\\1a&HFF&\\3a&HFF&}' : '') + cue.lines.map(l => l.map(x => {
    const t = tags(x, { ...opts(x), box });
    return t ? `{${t}}${show(x)}${after(box)}` : show(x);
  }).join(' ')).join('\\N');
  for (const cue of cues) {
    if (cue.note) { event(0, cue.start, cue.end, 'Note', assText(cue.text)); continue; }
    if (c.highlight === 'off') { event(0, cue.start, cue.end, 'Caption', draw(cue, () => ({}))); continue; }
    const all = cue.lines.flat();
    all.forEach((x, i) => {
      const t0 = i ? x.start : cue.start, t1 = i + 1 < all.length ? all[i + 1].start : cue.end;
      const opts = y => ({ t0, active: y === x, previous: i > 0 && y === all[i - 1], lit: c.highlight === 'karaoke' ? all.indexOf(y) <= i : y === x });
      if (c.highlight === 'box') event(0, t0, t1, 'CaptionBox', draw(cue, opts, true));
      event(c.highlight === 'box' ? 1 : 0, t0, t1, 'Caption', draw(cue, opts));
    });
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}
