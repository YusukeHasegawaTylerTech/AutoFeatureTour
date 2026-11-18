"""Piper speech for AutoFeatureTour (src/tts.mjs, provider "piper").

One process per run: it reads one JSON request per line on stdin and answers one JSON line on stdout, so each voice
model is loaded once, not once per scene.

  request:  { "model": "<voice>.onnx", "text": "...", "wav": "<out>.wav", "speed": 1.0 }
            (speed: 2 says it twice as fast as the voice's own pace)
  answer:   { "ok": true, "seconds": 7.3, "sampleRate": 22050,
              "chunks": [ { "start": 0.0, "end": 1.6, "words": [0.0, 0.52, 0.75, 1.07] }, ... ] }
            { "ok": false, "error": "..." }

A chunk is a sentence as Piper split it; "words" are when each of its words starts (seconds into the wav), read from
the model's phoneme durations: the model is patched in memory to expose them (needs the onnx package). Without them
a chunk has no "words" and tts.mjs spreads the text's words over the chunk.
"""

import json
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

try:
    from piper import PiperVoice, SynthesisConfig
except Exception as e:  # noqa: BLE001
    print(json.dumps({"ok": False, "error": f"piper-tts is not installed for {sys.executable}: {e}"}), flush=True)
    sys.exit(1)

voices = {}


def load(model):
    if model not in voices:
        try:
            voices[model] = (PiperVoice.load(model, include_alignments=True), True)
        except Exception:  # noqa: BLE001  (no onnx package, or a model that can't be patched)
            voices[model] = (PiperVoice.load(model), False)
    return voices[model]


def say(req):
    voice, aligned = load(req["model"])
    rate = voice.config.sample_rate
    config = SynthesisConfig(length_scale=voice.config.length_scale / float(req.get("speed") or 1))
    chunks, at = [], 0
    with wave.open(req["wav"], "wb") as out:
        out.setframerate(rate)
        out.setsampwidth(2)
        out.setnchannels(1)
        for chunk in voice.synthesize(req["text"], syn_config=config, include_alignments=aligned):
            samples = chunk.audio_int16_array
            out.writeframes(samples.tobytes())
            entry = {"start": at / rate, "end": (at + len(samples)) / rate}
            if chunk.phoneme_alignments:
                # Words are separated by the space phoneme; a word starts after the one before it.
                pos, starts, fresh = at, [], True
                for a in chunk.phoneme_alignments:
                    if a.phoneme == " ":
                        fresh = True
                    elif fresh and a.phoneme not in ("^", "$", "_"):
                        starts.append(round(pos / rate, 3))
                        fresh = False
                    pos += a.num_samples
                entry["words"] = starts
            chunks.append(entry)
            at += len(samples)
    return {"ok": True, "seconds": at / rate, "sampleRate": rate, "aligned": aligned, "chunks": chunks}


print(json.dumps({"ok": True, "ready": True}), flush=True)
for line in sys.stdin:
    if not line.strip():
        continue
    try:
        answer = say(json.loads(line))
    except Exception as e:  # noqa: BLE001
        answer = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(answer), flush=True)
