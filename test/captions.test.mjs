import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captionSettings, splitCues, timeWords, videoCues, writeAss, writeVtt } from '../src/captions.mjs';
import { spokenText } from '../src/script.mjs';
import { estimateWords, sapiWords } from '../src/tts.mjs';
import { sceneStarts } from '../ui/public/media.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-captions-'));
const text = cue => cue.lines.map(l => l.map(w => w.text).join(' '));

test('settings: defaults, the tour/platform "video.captions", then the command line; bad values are refused', () => {
  assert.deepEqual([captionSettings().mode, captionSettings().maxCharsPerLine, captionSettings().maxLines, captionSettings().highlight], ['file', 42, 2, 'off']);
  const c = captionSettings({ captions: { mode: 'soft', maxCharsPerLine: 30 } }, { captions: 'burn', highlight: true, captionLines: '1' });
  assert.deepEqual([c.mode, c.maxCharsPerLine, c.maxLines, c.highlight], ['burn', 30, 1, 'word']);
  assert.equal(captionSettings({ captions: { mode: 'burn' } }, { noCaptions: true }).mode, 'off');
  assert.equal(captionSettings({}, { charsPerLine: '24' }).maxCharsPerLine, 24);
  assert.throws(() => captionSettings({}, { captions: 'sideways' }), /not a mode/);
  assert.throws(() => captionSettings({}, { highlight: 'glow' }), /highlight/);
  assert.throws(() => captionSettings({}, { charsPerLine: '5' }), /characters per line/);
  assert.throws(() => captionSettings({ captions: { highlightColor: 'yellow' } }), /colour/);
});

test('words are shown as written and timed as said: a pronounce substitution keeps its word on time', () => {
  const pronounce = { RMS: 'R M S' };
  const display = spokenText('In **RMS** the clerk opens it.');
  const spoken = spokenText(display, pronounce);
  assert.equal(spoken, 'In R M S the clerk opens it.');
  // The voice: In@0 R@1 M@1.3 S@1.6 the@2 clerk@2.4 opens@3 it@3.5
  const at = { In: 0, R: 1, M: 1.3, S: 1.6, the: 2, 'clerk': 2.4, opens: 3, 'it.': 3.5 };
  const voiced = [...spoken.matchAll(/\S+/g)].map(m => ({ start: at[m[0]], char: m.index, length: m[0].length }));
  const words = timeWords(display, t => spokenText(t, pronounce), voiced, 4);
  assert.deepEqual(words.map(w => [w.text, w.start]), [['In', 0], ['RMS', 1], ['the', 2], ['clerk', 2.4], ['opens', 3], ['it.', 3.5]]);
  assert.equal(words.at(-1).end, 4);
  // No word times: spread by position.
  const even = timeWords('one two three four', t => t, [], 8);
  assert.ok(even.every((w, i) => i === 0 || w.start > even[i - 1].start));
});

test('cues: at most N characters × M lines, balanced, a sentence per cue at least', () => {
  const display = 'The records clerk opens the request queue and filters it to the open requests from this week. Then she approves one.';
  const words = timeWords(display, t => t, estimateWords(display, 10), 10);
  const cues = splitCues(words, { maxCharsPerLine: 32, maxLines: 2 });
  for (const c of cues) {
    assert.ok(c.lines.length <= 2, JSON.stringify(text(c)));
    for (const l of text(c)) assert.ok(l.length <= 32, l);
  }
  assert.deepEqual(text(cues.at(-1)), ['Then she approves one.'], 'the second sentence starts its own cue');
  assert.ok(cues.every((c, i) => i === 0 || c.start === cues[i - 1].end), 'each cue runs until the next starts');
  // Balanced: no long line over a lone word.
  const two = splitCues(timeWords('alpha beta gamma delta epsilon zeta eta', t => t, [], 5), { maxCharsPerLine: 30, maxLines: 2 });
  assert.equal(two.length, 1);
  const [a, b] = text(two[0]);
  assert.ok(Math.abs(a.length - b.length) <= 8, `${a} / ${b}`);
  // One line of 20: more cues, none longer.
  const narrow = splitCues(words, { maxCharsPerLine: 20, maxLines: 1 });
  assert.ok(narrow.length > cues.length && narrow.every(c => c.lines.length === 1 && text(c)[0].length <= 20));
});

test('vtt: the first cue of each scene is named and starts with the scene, so the UI markers still find the scenes', () => {
  const s1 = timeWords('First sentence here. And a second one.', t => t, [], 3);
  const cues = videoCues([{ id: 'scene-01', words: s1, length: 4, mocked: true }, { id: 'scene-02', words: [], length: 2 }], { maxCharsPerLine: 42, maxLines: 2 });
  const dir = tmp();
  writeVtt(cues, path.join(dir, 'c.vtt'));
  const vtt = fs.readFileSync(path.join(dir, 'c.vtt'), 'utf8');
  assert.match(vtt, /^scene-01\n00:00:00\.000 -->/m);
  assert.match(vtt, /^scene-01\.2\n/m);
  assert.match(vtt, /^scene-02\n00:00:04\.000 -->/m, 'a scene with nothing said still has its cue');
  assert.match(vtt, /line:5%\nSimulated data/);
  assert.deepEqual(sceneStarts(vtt), [0, 4]);
  // Runs made before: one unnamed cue per scene.
  assert.deepEqual(sceneStarts('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nA\n\n00:00:03.500 --> 00:00:05.000\nB\n'), [0, 3.5]);
});

test('ass: highlight word colours only the word being said; karaoke every word so far', () => {
  const words = timeWords('one two three', t => t, [{ start: 0, char: 0, length: 3 }, { start: 1, char: 4, length: 3 }, { start: 2, char: 8, length: 5 }], 3);
  const cues = videoCues([{ id: 'scene-01', words, length: 3 }], { maxCharsPerLine: 42, maxLines: 2 });
  const dir = tmp();
  const events = highlight => {
    writeAss(cues, path.join(dir, 'c.ass'), captionSettings({ captions: { highlight } }));
    return fs.readFileSync(path.join(dir, 'c.ass'), 'utf8').split('\n').filter(l => l.startsWith('Dialogue:'));
  };
  assert.equal(events('off').length, 1);
  const word = events('word');
  assert.equal(word.length, 3);
  assert.match(word[1], /^Dialogue: 0,0:00:01\.00,0:00:02\.00,Caption,,0,0,0,,one \{\\c&H4AD5FF&\}two\{\\c&HFFFFFF&\} three$/);
  assert.match(events('karaoke')[2], /\}one\{.*\}two\{.*\}three\{/);
});

test('sapi word marks: times scaled to the wav, positions less the SSML header, repeats dropped', () => {
  const t = 'Hi there, 80% done.';
  const said = { end: 8, marks: [{ t: 0.2, c: 82, n: 2 }, { t: 1, c: 85, n: 5 }, { t: 3, c: 92, n: 3 }, { t: 4, c: 92, n: 3 }, { t: 6, c: 96, n: 4 }] };
  const words = sapiWords(t, said, 4);
  assert.deepEqual(words.map(w => [t.slice(w.char, w.char + w.length), w.start]), [['Hi', 0.1], ['there', 0.5], ['80%', 1.5], ['done', 3]]);
  assert.deepEqual(sapiWords(t, null, 4), []);
});
