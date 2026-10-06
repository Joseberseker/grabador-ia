#!/usr/bin/env python3
"""Genera los iconos temporales (círculo rojo «REC» sobre fondo oscuro).

Uso: python3 scripts/generate-icons.py   (requiere Pillow: pip install pillow)
Sustituye los PNG de icons/ por el diseño definitivo cuando exista.
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
OUT_DIR = Path(__file__).resolve().parent.parent / "icons"
SCALE = 4  # supersampling para bordes suaves


def make_icon(size: int) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 5, fill=(32, 33, 36, 255))
    ring = s * 0.16
    draw.ellipse((ring, ring, s - ring, s - ring), outline=(255, 255, 255, 255), width=max(SCALE, s // 16))
    dot = s * 0.30
    draw.ellipse((dot, dot, s - dot, s - dot), fill=(217, 48, 37, 255))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT_DIR.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        make_icon(size).save(path)
        print(f"✓ {path.relative_to(OUT_DIR.parent)}")
