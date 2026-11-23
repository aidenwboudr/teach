#!/usr/bin/env python3
"""Speech to text for Teach's voice input (TEACH_STT_CMD), with faster-whisper on the CPU.

Teach starts this once, the first time the learner speaks, and keeps it while they do (it stops it after a while
unused, giving the memory back). One request per line on stdin, one answer per line on stdout:

  {"id": 1, "path": "/tmp/clip.wav", "prompt": "words the clip may use"}
  {"id": 1, "text": "the second one", "no_speech": 0.02, "ms": 640}

`prompt` (optional) is a hint for spelling: the topic's title and the question's options, so "Thevenin" comes out
as Thevenin. Anything that isn't speech comes back as "" (faster-whisper's own voice detector drops it).

Settings: TEACH_WHISPER_MODEL (default small.en; base.en is faster and rougher), TEACH_WHISPER_DIR (where models
are, or get downloaded to), TEACH_WHISPER_THREADS (default 4).
  pip install faster-whisper
"""
import json
import os
import sys
import time

from faster_whisper import WhisperModel

model = WhisperModel(os.environ.get("TEACH_WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8",
                     cpu_threads=int(os.environ.get("TEACH_WHISPER_THREADS", "4")),
                     download_root=os.environ.get("TEACH_WHISPER_DIR") or None)
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    t0 = time.time()
    try:
        segs, _ = model.transcribe(req["path"], beam_size=1, language="en", vad_filter=True,
                                   condition_on_previous_text=False, initial_prompt=(req.get("prompt") or None))
        segs = list(segs)
        text = " ".join(s.text.strip() for s in segs).strip()
        no_speech = max((s.no_speech_prob for s in segs), default=1.0)
        out = {"id": req.get("id"), "text": text, "no_speech": round(no_speech, 3), "ms": round((time.time() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001 - a bad clip answers with its error; the next one still works
        out = {"id": req.get("id"), "error": str(e)[:200]}
    print(json.dumps(out), flush=True)
