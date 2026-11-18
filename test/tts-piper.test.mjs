import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piperSpeed, piperWords } from '../src/tts.mjs';

test('piperWords: as many words said as written pair one for one', () => {
  const text = 'Agents do not save tokens. They help usage tracking.';
  const said = { seconds: 4, chunks: [{ start: 0, end: 1.8, words: [0, 0.5, 0.7, 0.9, 1.2] }, { start: 1.8, end: 4, words: [1.8, 2.1, 2.4, 2.9] }] };
  const w = piperWords(text, said);
  assert.equal(w.length, 9);
  assert.deepEqual(w[0], { start: 0, char: 0, length: 6 });
  assert.deepEqual(w[5], { start: 1.8, char: text.indexOf('They'), length: 4 });
  assert.equal(w[8].start, 2.9);
});

test('piperWords: a sentence said in more words ("80%") is spread over its own time; the others still pair', () => {
  const text = 'It saves 80% here. Then it stops.';
  const said = { seconds: 4, chunks: [{ start: 0, end: 2, words: [0, 0.2, 0.5, 0.8, 1.1] }, { start: 2, end: 4, words: [2, 2.4, 2.7] }] };
  const w = piperWords(text, said);
  assert.equal(w.length, 7);
  assert.ok(w.slice(0, 4).every(x => x.start >= 0 && x.start < 2));
  assert.deepEqual(w.slice(4).map(x => x.start), [2, 2.4, 2.7]);
  assert.equal(w[4].char, text.indexOf('Then'));
});

test('piperWords: no word times, or sentences that do not pair, spread the whole text', () => {
  const text = 'One two three.';
  assert.equal(piperWords(text, { seconds: 3, chunks: [{ start: 0, end: 3 }] }).length, 3);
  assert.equal(piperWords(text, null).length, 3);
});

test('piperSpeed: SAPI rate -10..10 as a speed, 1 at 0, about 3x at the ends', () => {
  assert.equal(piperSpeed(0), 1);
  assert.equal(piperSpeed(10), 3);
  assert.equal(piperSpeed(-10), +(1 / 3).toFixed(3));
  assert.equal(piperSpeed(99), 3);
});
