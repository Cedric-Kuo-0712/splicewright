"""Speech transcript (§8), ported from video-cut/scripts/transcribe.py. Output, in asset seconds:
{ language, segments: [{ start, end, text }] }. Model: $SPLICEWRIGHT_WHISPER_MODEL (default "base")."""
import os
import platform

from common import decode, need, run

faster_whisper = need("faster_whisper")

model_size = os.environ.get("SPLICEWRIGHT_WHISPER_MODEL", "base")
try:
    # Apple Silicon: ctranslate2 runs on CPU (Accelerate); elsewhere try CUDA first.
    if platform.system() == "Darwin":
        raise RuntimeError
    model = faster_whisper.WhisperModel(model_size, device="cuda", compute_type="float16")
except Exception:
    model = faster_whisper.WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=4)


def transcribe(path):
    segments, info = model.transcribe(decode(path, 16000), beam_size=5, vad_filter=True)
    segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments if s.text.strip()]
    return {"language": info.language if segs else None, "segments": segs}


run(transcribe)
