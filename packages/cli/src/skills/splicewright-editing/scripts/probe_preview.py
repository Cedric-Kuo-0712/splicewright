#!/usr/bin/env python3
"""Read dimensions and a few RGB pixels from an already-generated bounded preview."""
import argparse
import json
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("preview")
parser.add_argument("--point", nargs=2, type=int, action="append", metavar=("X", "Y"))
args = parser.parse_args()
try:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", args.preview],
        check=True, capture_output=True, text=True,
    )
    streams = json.loads(result.stdout)["streams"]
    width, height = streams[0]["width"], streams[0]["height"]
    if not 0 < width <= 1280 or not 0 < height <= 1280:
        raise ValueError("Use a bounded preview from source_frame/material_preview/still; maximum dimension is 1280")
    points = args.point or [(width // 2, height // 2)]
    if len(points) > 8:
        raise ValueError("At most eight probe points are supported")
    pixels = []
    for x, y in points:
        if not (0 <= x < width and 0 <= y < height):
            raise ValueError(f"Point {x},{y} is outside {width}x{height}")
        # Convert before cropping: YUV subsampling otherwise rejects one-pixel crops.
        sample = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", args.preview, "-vf", f"format=rgb24,crop=1:1:{x}:{y}", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
            check=True, capture_output=True,
        ).stdout
        if len(sample) != 3:
            raise ValueError("Expected one RGB pixel")
        pixels.append({"point": [x, y], "rgb": list(sample)})
    print(json.dumps({"size": [width, height], "pixels": pixels}))
except (OSError, ValueError, KeyError, IndexError, subprocess.CalledProcessError) as error:
    parser.exit(1, f"Preview probe failed: {error}\n")
