"""Shared by the Python ingest steps (§8). Each script takes `<input> <output>` pairs, writes one JSON
file per pair, and prints one JSON line per file to stdout. Exit code 3 means a module is missing."""
import json
import subprocess
import sys

import numpy as np


def need(module):
    try:
        return __import__(module)
    except ImportError:
        print(json.dumps({"missing": module}))
        sys.exit(3)


def decode(path, sr):
    """Mono float32 PCM via ffmpeg, so every container ffmpeg reads works (m4a, mov, ...)."""
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def run(fn):
    args = sys.argv[1:]
    for src, dst in zip(args[::2], args[1::2]):
        try:
            with open(dst, "w", encoding="utf-8") as f:
                json.dump(fn(src), f, ensure_ascii=False)
            print(json.dumps({"ok": dst}), flush=True)
        except Exception as e:  # one bad file must not stop the batch
            print(json.dumps({"error": dst, "message": str(e)[-300:]}), flush=True)
