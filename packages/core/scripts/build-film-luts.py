#!/usr/bin/env python3
"""Rebuild bundled film .cube LUTs from pinned t3mujinpack Hald PNGs.

Only supports the upstream RGB8 Hald PNGs used here; no image color management is
performed. Run from any directory with Python 3.10+: python3 build-film-luts.py.
Missing inputs are fetched from the pinned Git commit and checked by Git blob SHA-1.
"""
from __future__ import annotations

import hashlib
import gzip
import json
import random
import struct
from array import array
import urllib.request
from urllib.parse import quote
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/luts/film"
SOURCE_DIR = OUT / "source"
UPSTREAM = "https://raw.githubusercontent.com/t3mujinpack/t3mujinpack/0b421f3e25209ed78253d1724a29cc6255c5e7fe/haldcluts"
GRID = 65
SAMPLES = 25000
SEED = 4701
SOURCES = [
    ("Kodak Portra 400", "t3mujinpack - Color Negative - Kodak Portra 400.png", "haldcluts/t3mujinpack - Color Negative - Kodak Portra 400.png", "0d97477027d62366e6dc980befca40042cfe1962"),
    ("Kodak Gold 200", "t3mujinpack - Color Negative - Kodak Gold 200.png", "haldcluts/t3mujinpack - Color Negative - Kodak Gold 200.png", "9c928ec6cce36247c5a960d8d8b5f9681a570d98"),
    ("Fuji Velvia 50", "t3mujinpack - Color Slide - Fuji Velvia 50.png", "haldcluts/t3mujinpack - Color Slide - Fuji Velvia 50.png", "a443d6890edf45123a4288230d64c2be2921e4be"),
    ("Fuji Provia 100F", "t3mujinpack - Color Slide - Fuji Provia 100F.png", "haldcluts/t3mujinpack - Color Slide - Fuji Provia 100F.png", "c66f73ed74c71db7e3a68882845d5a87e2b5d92d"),
    ("Ilford HP5 Plus 400", "t3mujinpack - Black and White - Ilford HP5 Plus 400.png", "haldcluts/t3mujinpack - Black and White - Ilford HP5 Plus 400.png", "f66aa59a5bf805f0fc60200791e0bbbd68ac79c4"),
]


def blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def read_rgb_png(data: bytes) -> tuple[int, int, bytes]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("source is not a PNG")
    pos, width, height, channels = 8, 0, 0, 0
    compressed = bytearray()
    while pos < len(data):
        size = struct.unpack_from(">I", data, pos)[0]
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + size]
        pos += 12 + size
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, color, compression, filtering, interlace) != (8, 2, 0, 0, 0):
                raise ValueError("expected non-interlaced RGB8 Hald PNG")
            channels = 3
        elif kind == b"IDAT":
            compressed.extend(body)
        elif kind == b"IEND":
            break
    raw = zlib.decompress(compressed)
    stride, bpp = width * channels, channels
    pixels = bytearray(height * stride)
    source = 0
    for y in range(height):
        f = raw[source]
        source += 1
        row = bytearray(raw[source : source + stride])
        source += stride
        prev = pixels[(y - 1) * stride : y * stride] if y else bytes(stride)
        for i in range(stride):
            a = row[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                row[i] = (row[i] + a) & 255
            elif f == 2:
                row[i] = (row[i] + b) & 255
            elif f == 3:
                row[i] = (row[i] + ((a + b) // 2)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            elif f != 0:
                raise ValueError(f"unsupported PNG filter {f}")
        pixels[y * stride : (y + 1) * stride] = row
    if source != len(raw):
        raise ValueError("unexpected trailing PNG scanline bytes")
    return width, height, bytes(pixels)


def hald_lut(path: Path, expected: str):
    data = path.read_bytes()
    actual = blob_sha1(data)
    if actual != expected:
        raise ValueError(f"{path.name}: pinned source Git blob SHA-1 mismatch ({actual})")
    width, height, rgb = read_rgb_png(data)
    if width != height:
        raise ValueError("Hald PNG must be square")
    n = round(width ** (1 / 3))
    size = n * n
    if n**3 != width:
        raise ValueError(f"Hald width {width} is not a perfect cube")

    def at(r: int, g: int, b: int):
        index = r + g * size + b * size * size
        offset = index * 3
        return tuple(v / 255 for v in rgb[offset : offset + 3])

    def sample(r: float, g: float, b: float):
        coords = [v * (size - 1) for v in (r, g, b)]
        lo = [int(v) for v in coords]
        hi = [min(v + 1, size - 1) for v in lo]
        t = [coords[i] - lo[i] for i in range(3)]
        out = [0.0, 0.0, 0.0]
        for bz in range(2):
            for gy in range(2):
                for rx in range(2):
                    w = (t[0] if rx else 1 - t[0]) * (t[1] if gy else 1 - t[1]) * (t[2] if bz else 1 - t[2])
                    value = at((hi[0] if rx else lo[0]), (hi[1] if gy else lo[1]), (hi[2] if bz else lo[2]))
                    for c in range(3):
                        out[c] += value[c] * w
        return out

    return sample


def cube_sample(table, size: int, rgb):
    coords = [v * (size - 1) for v in rgb]
    lo = [int(v) for v in coords]
    hi = [min(v + 1, size - 1) for v in lo]
    t = [coords[i] - lo[i] for i in range(3)]
    out = [0.0, 0.0, 0.0]
    for bz in range(2):
        for gy in range(2):
            for rx in range(2):
                w = (t[0] if rx else 1 - t[0]) * (t[1] if gy else 1 - t[1]) * (t[2] if bz else 1 - t[2])
                index = (hi[0] if rx else lo[0]) + (hi[1] if gy else lo[1]) * size + (hi[2] if bz else lo[2]) * size * size
                value = table[index * 3 : index * 3 + 3]
                for c in range(3):
                    out[c] += value[c] * w
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    reports = []
    for name, local_name, upstream_path, expected_sha in SOURCES:
        source = SOURCE_DIR / local_name
        if not source.exists():
            source.parent.mkdir(parents=True, exist_ok=True)
            request = urllib.request.Request(f"{UPSTREAM}/{quote(upstream_path.rsplit('/', 1)[-1])}", headers={"User-Agent": "Splicewright-LUT-builder"})
            source.write_bytes(urllib.request.urlopen(request, timeout=30).read())
        source_sample = hald_lut(source, expected_sha)
        rng = random.Random(SEED)
        size = GRID
        # The source Hald has a 144-node edge (level 12 squared). Resample it onto
        # a GRID-node lattice (trilinear), red-fast order, six-decimal values.
        table = array("d")
        for b in range(size):
            for g in range(size):
                for r in range(size):
                    table.extend(round(v, 6) for v in source_sample(r / (size - 1), g / (size - 1), b / (size - 1)))
        # Error of the serialized grid vs the full-resolution Hald, in 8-bit levels.
        errors = []
        for _ in range(SAMPLES):
            rgb = [rng.random() for _ in range(3)]
            expected = source_sample(*rgb)
            actual = cube_sample(table, size, rgb)
            errors.append(max(abs(a - b) for a, b in zip(expected, actual)) * 255)
        errors.sort()
        err = {"mean": sum(errors) / len(errors), "p99": errors[int(len(errors) * 0.99)], "max": errors[-1]}
        cube = [
            f'TITLE "{name} - creative SDR look, input profile unspecified"',
            f"# Source: t3mujinpack/t3mujinpack@0b421f3e25209ed78253d1724a29cc6255c5e7fe/{upstream_path}",
            f"# Source Git blob SHA-1: {expected_sha}",
            f"# Conversion: build-film-luts.py v3, Python stdlib, trilinear resample of the Hald RGB8 lattice, grid {size}",
            f"# Error vs full-res Hald, {SAMPLES} points (seed {SEED}), 8-bit levels: mean {err['mean']:.4f} p99 {err['p99']:.4f} max {err['max']:.4f}",
            f"LUT_3D_SIZE {size}",
            "DOMAIN_MIN 0 0 0",
            "DOMAIN_MAX 1 1 1",
        ]
        dest = OUT / (name.lower().replace(" ", "-") + ".cube.gz")
        with gzip.GzipFile(filename=str(dest), mode="wb", compresslevel=9, mtime=0) as stream:
            for line in cube:
                stream.write((line + "\n").encode("ascii"))
            for i in range(0, len(table), 3):
                stream.write(("%.6f %.6f %.6f\n" % tuple(table[i : i + 3])).encode("ascii"))
        compressed = dest.read_bytes()
        expanded_hash = hashlib.sha256()
        expanded_bytes = 0
        with gzip.open(dest, "rb") as stream:
            while chunk := stream.read(1 << 20):
                expanded_hash.update(chunk)
                expanded_bytes += len(chunk)
        reports.append({"name": name, "size": size, "samples": SAMPLES, "seed": SEED, "error_8bit_levels": err,
                        "source_git_blob_sha1": expected_sha, "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "cube_sha256": expanded_hash.hexdigest(), "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
                        "cube_bytes": expanded_bytes, "compressed_bytes": len(compressed)})
    previous_record = json.loads((OUT / "build-record.json").read_text(encoding="utf-8")) if (OUT / "build-record.json").exists() else {}
    record = {"converter": "build-film-luts.py v3", "python": "stdlib", "grid": GRID, "format": "RGB8 Hald -> 65^3 red-fast .cube; 6-decimal RGB; gzip level 9, mtime 0", "source_image_profile": "embedded sRGB ICC; pixel bytes consumed unchanged", "lut_input_profile": "unspecified", "verified_at_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "results": reports, "resolution_trials": previous_record.get("resolution_trials", [])}
    (OUT / "build-record.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    for result in reports:
        print(f"{result['name']}: size={result['size']} err={result['error_8bit_levels']} bytes={result['cube_bytes']}/{result['compressed_bytes']} sha256={result['cube_sha256']}")


if __name__ == "__main__":
    main()
