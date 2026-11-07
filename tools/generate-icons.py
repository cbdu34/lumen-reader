#!/usr/bin/env python3
"""Generate Lumen's PNG icons with the standard library only.

Usage:  python3 tools/generate-icons.py [output-directory]

The mark is deliberately simple so it survives at 16 px: an ink rounded square
holding three "text lines", the last one in amber.
"""

import pathlib
import struct
import sys
import zlib

SUPERSAMPLE = 4  # 4x4 samples per pixel, for smooth edges

INK = (26, 23, 19)
PAPER = (244, 236, 220)
ACCENT = (226, 154, 74)

SIZES = (16, 32, 48, 128)


def _inside_rounded(x, y, x0, y0, width, height, radius):
    """Point-in-rounded-rectangle test."""
    if x < x0 or y < y0 or x > x0 + width or y > y0 + height:
        return False
    cx = min(max(x, x0 + radius), x0 + width - radius)
    cy = min(max(y, y0 + radius), y0 + height - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def _png(size, rows):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA
    raw = b"".join(b"\x00" + row for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def render(size):
    n = size * SUPERSAMPLE
    total = SUPERSAMPLE * SUPERSAMPLE

    background = lambda x, y: _inside_rounded(x, y, 0, 0, n, n, 0.222 * n)
    bars = (
        (lambda x, y: _inside_rounded(x, y, 0.235 * n, 0.325 * n, 0.52 * n, 0.072 * n, 0.036 * n), PAPER),
        (lambda x, y: _inside_rounded(x, y, 0.235 * n, 0.455 * n, 0.395 * n, 0.072 * n, 0.036 * n), PAPER),
        (lambda x, y: _inside_rounded(x, y, 0.235 * n, 0.585 * n, 0.455 * n, 0.072 * n, 0.036 * n), ACCENT),
    )

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            red = green = blue = covered = 0
            for sy in range(SUPERSAMPLE):
                y = py * SUPERSAMPLE + sy + 0.5
                for sx in range(SUPERSAMPLE):
                    x = px * SUPERSAMPLE + sx + 0.5
                    if not background(x, y):
                        continue
                    color = INK
                    for test, value in bars:
                        if test(x, y):
                            color = value
                            break
                    red += color[0]
                    green += color[1]
                    blue += color[2]
                    covered += 1
            if covered == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes(
                    (
                        red // covered,
                        green // covered,
                        blue // covered,
                        round(255 * covered / total),
                    )
                )
        rows.append(bytes(row))
    return _png(size, rows)


def main(argv):
    root = pathlib.Path(__file__).resolve().parent.parent
    target = pathlib.Path(argv[1]) if len(argv) > 1 else root / "icons"
    target.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = target / f"icon{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path.relative_to(root)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv)
