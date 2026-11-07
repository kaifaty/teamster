#!/usr/bin/env python3
"""Turn generated art into the files the map loads: python3 art/prepare.py SOURCE_DIR.

Standard library only. Sprites on magenta lose their background, balls on black are cropped to the ball and
lose the black around it, and macOS `sips` scales the results into src/map/art. Files named backdrop-*.png
become the skies of the star systems.

With --project TARGET_DIR it prepares the art of one repository instead: sky.png, planet.png and emblem.png,
whichever exist, go into TARGET_DIR, which lies outside this repository (see PROMPTS.md).
"""

import argparse
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src/map/art"

# name: (kind, size of the longest side)
SPRITES = {
    "ship-blue": ("key", 192),
    "ship-copper": ("key", 192),
    "ship-scout": ("key", 128),
    "flagship": ("key", 384),
    "ship-blue-frigate": ("key", 224),
    "ship-blue-cruiser": ("key", 288),
    "ship-copper-frigate": ("key", 224),
    "ship-copper-cruiser": ("key", 288),
    "tanker": ("key", 160),
    "escort": ("key", 96),
    "station-command": ("key", 384),
    "station-research": ("key", 384),
    "gate": ("key", 320),
    "depot": ("key", 224),
    "planet-yard": ("ball", 448),
    "planet-range": ("ball", 320),
    "planet-inspection": ("ball", 448),
    "planet-roadstead": ("ball", 288),
    "planet-cryo": ("ball", 352),
    "sun": ("sun", 512),
}

# The same for the art of one repository. Its sky goes through as a JPEG.
PROJECT_SPRITES = {
    "planet": ("ball", 448),
    "emblem": ("key", 128),
}


def read_png(path):
    data = path.read_bytes()
    pos, idat = 8, bytearray()
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or color not in (2, 6) or interlace:
                raise SystemExit(f"{path}: expected 8-bit RGB or RGBA without interlacing")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    channels = 3 if color == 2 else 4
    raw, stride = zlib.decompress(bytes(idat)), width * channels
    rows, previous = [], bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        if kind == 1:
            for i in range(channels, stride):
                row[i] = (row[i] + row[i - channels]) & 255
        elif kind == 2:
            for i in range(stride):
                row[i] = (row[i] + previous[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                row[i] = (row[i] + (left + previous[i]) // 2) & 255
        elif kind == 4:
            for i in range(stride):
                a = row[i - channels] if i >= channels else 0
                b = previous[i]
                c = previous[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(row)
        previous = row
    return width, height, channels, rows


def write_png(path, width, height, rows):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    raw = b"".join(b"\0" + bytes(row) for row in rows)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def key_magenta(width, height, channels, rows):
    """Alpha from how magenta a pixel is; edge pixels lose their magenta tint."""
    result = []
    for row in rows:
        out = bytearray(width * 4)
        for x in range(width):
            r, g, b = row[x * channels:x * channels + 3]
            spill = min(r, b) - g
            alpha = 255
            if spill > 70:
                alpha = max(0, min(255, (150 - spill) * 255 // 80))
                r, b = min(r, g + 60), min(b, g + 60)
            out[x * 4:x * 4 + 4] = bytes((r, g, b, alpha))
        result.append(out)
    return width, height, result


def ball_radius(width, height, channels, rows, level):
    """Half the width of the bright part of the middle row."""
    row = rows[height // 2]
    bright = [x for x in range(width) if max(row[x * channels:x * channels + 3]) > level]
    return (bright[-1] - bright[0]) / 2, (bright[-1] + bright[0]) / 2


def cut_ball(width, height, channels, rows, level, margin, gain):
    """A square around the ball; outside the ball, the black turns transparent and the glow stays."""
    radius, cx = ball_radius(width, height, channels, rows, level)
    cy = height / 2
    half = int(radius * margin)
    x0, y0 = int(cx) - half, int(cy) - half
    size = half * 2
    result = []
    for y in range(size):
        out = bytearray(size * 4)
        source = rows[y + y0] if 0 <= y + y0 < height else None
        for x in range(size):
            if source is None or not 0 <= x + x0 < width:
                continue
            r, g, b = source[(x + x0) * channels:(x + x0) * channels + 3]
            alpha = 255
            if (x + x0 - cx) ** 2 + (y + y0 - cy) ** 2 > (radius - 1) ** 2:
                alpha = min(255, int(max(r, g, b) * gain))
            out[x * 4:x * 4 + 4] = bytes((r, g, b, alpha))
        result.append(out)
    return size, size, result


def scale(source, target, longest):
    subprocess.run(["sips", "-Z", str(longest), str(source), "--out", str(target)], check=True, capture_output=True)


def prepare_sprite(source, target, kind, longest, temp):
    image = read_png(source)
    if kind == "key":
        width, height, rows = key_magenta(*image)
    elif kind == "ball":
        width, height, rows = cut_ball(*image, level=40, margin=1.04, gain=2.2)
    else:
        width, height, rows = cut_ball(*image, level=150, margin=1.5, gain=1.6)
    keyed = Path(temp) / source.name
    write_png(keyed, width, height, rows)
    scale(keyed, target, longest)
    print(source.stem, width, height)


def prepare_project(source, target):
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        for name, (kind, longest) in PROJECT_SPRITES.items():
            if (source / f"{name}.png").exists():
                prepare_sprite(source / f"{name}.png", target / f"{name}.png", kind, longest, temp)
    if (source / "sky.png").exists():
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "68", str(source / "sky.png"), "--out", str(target / "sky.jpg")],
            check=True, capture_output=True,
        )


def main():
    parser = argparse.ArgumentParser(description="Turn generated art into the files the map loads.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--project", type=Path, metavar="TARGET_DIR", help="prepare one repository's art into this directory")
    args = parser.parse_args()
    source = args.source
    if args.project:
        prepare_project(source, args.project.expanduser())
        return
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        for name, (kind, longest) in SPRITES.items():
            prepare_sprite(source / f"{name}.png", OUT / f"{name}.png", kind, longest, temp)
    subprocess.run(
        ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", str(source / "nebula.png"), "--out", str(OUT / "nebula.jpg")],
        check=True, capture_output=True,
    )
    scale(source / "frame-light.png", OUT / "frame-light.png", 768)
    skies = OUT / "backdrops"
    skies.mkdir(exist_ok=True)
    for sky in sorted(source.glob("backdrop-*.png")):
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "68", str(sky), "--out", str(skies / f"{sky.stem}.jpg")],
            check=True, capture_output=True,
        )


if __name__ == "__main__":
    main()
