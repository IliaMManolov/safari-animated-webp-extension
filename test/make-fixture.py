"""Builds test animated WebP files shaped like the problem image.

The main fixture copies the structure that webpinfo showed for the real
file: a 672x1024 canvas, lossy frames, mostly-static content, so the
encoder emits sub-frames with alpha that blend over the previous frame,
and a key frame every few frames. Reference frames come from Pillow,
which decodes with libwebp's own animation decoder.

Usage: python3 test/make-fixture.py OUT_DIR
"""
import math
import os
import sys

from PIL import Image, ImageDraw


def scene(i, n, w, h):
    im = Image.new("RGB", (w, h), (235, 228, 214))
    d = ImageDraw.Draw(im)
    for y in range(0, h, 64):
        d.rectangle([0, y, w, y + 31], fill=(214, 205, 190))
    t = i / n * 2 * math.pi
    cx = w / 2 + math.cos(t) * w * 0.3
    cy = h / 2 + math.sin(t) * h * 0.3
    d.ellipse([cx - 80, cy - 80, cx + 80, cy + 80], fill=(200, 60, 50))
    bx = (i * 23) % (w - 120)
    d.rectangle([bx, 60, bx + 120, 180], fill=(40, 90, 180))
    return im


def save(path, frames, **kw):
    frames[0].save(path, save_all=True, append_images=frames[1:], **kw)


def refs(path, out_dir, prefix):
    with Image.open(path) as im:
        for k in range(im.n_frames):
            im.seek(k)
            im.convert("RGBA").save(os.path.join(out_dir, f"{prefix}-{k}.png"))
        return im.n_frames


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    w, h, n = 672, 1024, 40
    frames = [scene(i, n, w, h) for i in range(n)]
    main_path = os.path.join(out_dir, "heavy.webp")
    save(main_path, frames, duration=31, loop=0, lossless=False, quality=80,
         kmin=4, kmax=5, allow_mixed=False, minimize_size=False)
    count = refs(main_path, out_dir, "heavy")

    # A small transparent animation that uses dispose-to-background.
    small = []
    for i in range(12):
        im = Image.new("RGBA", (96, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse([i * 6, 8, i * 6 + 30, 38], fill=(20, 160, 90, 255))
        d.rectangle([0, 50, 95, 63], fill=(0, 0, 0, 128))
        small.append(im)
    small_path = os.path.join(out_dir, "alpha.webp")
    save(small_path, small, duration=50, loop=0, lossless=True, disposal=2)
    refs(small_path, out_dir, "alpha")

    # A still WebP, which the extension must leave alone.
    frames[0].save(os.path.join(out_dir, "still.webp"), quality=80)
    print(f"wrote {count} frames to {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1])
