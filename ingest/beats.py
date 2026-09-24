"""Beat analysis (§15.3): librosa onset strength + DP beat tracker, 4/4 downbeat heuristic.
Output, in asset seconds: { algo, version, tempo, beats: [{ t, strength }], downbeats: [t] }."""
from common import decode, need, run

librosa = need("librosa")
import numpy as np

SR = 22050
HOP = 256  # 11.6 ms per onset frame; well under the ±1 video frame target


def analyze(path):
    y = decode(path, SR)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, trim=False)
    # The DP grid can drift a few hops off the hits; pull each beat onto its local onset peak (±46 ms).
    w = 4
    frames = np.array([max(0, f - w) + int(np.argmax(env[max(0, f - w) : f + w + 1])) for f in np.asarray(frames, dtype=int)], dtype=int)
    # Low-band onsets (kick, bass) mark the "1".
    # ponytail: assumes 4/4 with the bass on the one (§15.3); a learned downbeat model fixes 3/4 and syncopation.
    low = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, fmax=200, n_mels=32)
    phase = int(np.argmax([low[frames[k::4]].sum() for k in range(4)])) if len(frames) >= 4 else 0
    times = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    peak = float(env.max()) or 1.0
    return {
        "algo": "librosa.beat_track",
        "version": librosa.__version__,
        "tempo": round(float(np.atleast_1d(tempo)[0]), 2),
        "beats": [{"t": round(float(t), 4), "strength": round(float(env[f]) / peak, 3)} for t, f in zip(times, frames)],
        "downbeats": [round(float(t), 4) for t in times[phase::4]],
    }


run(analyze)
