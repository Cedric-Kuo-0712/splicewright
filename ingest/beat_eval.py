"""§15.5 real-music check: F-measure of detected beats against a hand-tapped reference.

Tap the reference in the UI (select the song, Clear beats, play, press B on every beat), then:
    python ingest/beat_eval.py <project dir> <audio item id> [--tol 0.07]
Only the item's visible source range is scored. Prints one JSON line.
    python ingest/beat_eval.py --selftest
"""
import json
import sys
from pathlib import Path


def f_measure(ref, est, tol=0.07):
    """Greedy one-to-one matching in time order; each reference beat takes the closest unused estimate."""
    used, hits, offsets = set(), 0, []
    for r in ref:
        best = min((j for j, e in enumerate(est) if j not in used and abs(e - r) <= tol), key=lambda j: abs(est[j] - r), default=None)
        if best is not None:
            used.add(best)
            hits += 1
            offsets.append(est[best] - r)
    p = hits / len(est) if est else 0.0
    r = hits / len(ref) if ref else 0.0
    return {
        "f": round(2 * p * r / (p + r), 3) if p + r else 0.0,
        "precision": round(p, 3),
        "recall": round(r, 3),
        "ref": len(ref),
        "est": len(est),
        "meanOffsetMs": round(1000 * sum(offsets) / len(offsets), 1) if offsets else None,
    }


def main(args):
    tol = float(args[args.index("--tol") + 1]) if "--tol" in args else 0.07
    root, item_id = Path(args[0]), args[1]
    project = json.loads((root / "project.json").read_text())
    item = next((i for t in project["tracks"] for i in t["items"] if i["id"] == item_id), None)
    if not item or "assetId" not in item:
        sys.exit(f"no audio item {item_id}")
    cache = root / ".splicewright" / "beats" / f"{item['assetId']}.json"
    if not cache.exists():
        sys.exit(f"no {cache}; run splicewright ingest --only beats")
    lo = item["sourceIn"]
    hi = lo + item["duration"] / project["meta"]["fps"]
    inside = lambda ts: [t for t in ts if lo <= t < hi]
    ref = inside(item.get("beats", []))
    if len(ref) < 8:
        sys.exit(f"{item_id} has {len(ref)} tapped beats in range; tap a reference first")
    est = inside([b["t"] for b in json.loads(cache.read_text())["beats"]])
    print(json.dumps({"item": item_id, "asset": item["assetId"], "range": [round(lo, 3), round(hi, 3)], "tolMs": tol * 1000, **f_measure(ref, est, tol)}))


def selftest():
    ref = [0.5 * k for k in range(1, 21)]
    assert f_measure(ref, ref)["f"] == 1.0
    # 20 ms late everywhere: still all hits, and the offset shows it.
    assert f_measure(ref, [t + 0.02 for t in ref]) == {"f": 1.0, "precision": 1.0, "recall": 1.0, "ref": 20, "est": 20, "meanOffsetMs": 20.0}
    # Double tempo: every reference hit, half the estimates spurious.
    half = f_measure(ref, [0.25 * k for k in range(2, 42)])
    assert (half["precision"], half["recall"]) == (0.5, 1.0), half
    # Off by 100 ms: nothing within 70 ms; one estimate can't match two references.
    assert f_measure(ref, [t + 0.1 for t in ref])["f"] == 0.0
    assert f_measure([1.0, 1.05], [1.02])["recall"] == 0.5
    print("ok")


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main(sys.argv[1:])
