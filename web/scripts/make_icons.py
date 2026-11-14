"""Generate favicons, PWA icons, header logos and the link-preview image.

Sources (never modified): web/public/brand/logo.png and icon.png.
The logo is only resized; the dark-mode variant recolors the navy "LEDGER"
wordmark pixels to white so it stays readable on Night Navy.

    python web/scripts/make_icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

BRAND = Path(__file__).resolve().parents[1] / "public" / "brand"
PUBLIC = BRAND.parent
NIGHT_NAVY = (0, 10, 34, 255)
WHITE = (255, 255, 255, 255)


def fit(img: Image.Image, size: int, scale: float = 1.0) -> Image.Image:
    """Resize keeping the aspect ratio, centred on a transparent square."""
    box = int(size * scale)
    k = min(box / img.width, box / img.height)
    small = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(small, ((size - small.width) // 2, (size - small.height) // 2), small)
    return canvas


def on_background(img: Image.Image, color) -> Image.Image:
    bg = Image.new("RGBA", img.size, color)
    bg.alpha_composite(img)
    return bg


def dark_logo(logo: Image.Image) -> Image.Image:
    """White wordmark for dark surfaces: recolor only the navy 'LEDGER' letters."""
    a = np.array(logo).astype(np.int32)
    h, w = a.shape[:2]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    navy = (np.maximum(np.maximum(r, g), b) < 120) & (b >= r)
    region = np.zeros((h, w), dtype=bool)
    region[int(h * 0.655):int(h * 0.90), int(w * 0.42):] = True
    sel = navy & region
    a[sel, 0:3] = 255
    return Image.fromarray(a.astype(np.uint8))


def small_favicon(size: int) -> Image.Image:
    """Simplified mark for 16/32 px, where the detailed emblem turns into a blur:
    the heat-calendar grid from the emblem, in the brand colors."""
    from PIL import ImageDraw

    scale = 8
    n = size * scale
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n // 5, fill=NIGHT_NAVY)
    slate, yellow, orange, red, deep = "#3D5575", "#FDB300", "#FD8500", "#F61200", "#C60006"
    cells = [[slate, slate, yellow], [slate, orange, red], [orange, red, deep]]
    pad, gap = n * 0.14, n * 0.06
    side = (n - 2 * pad - 2 * gap) / 3
    for r in range(3):
        for c in range(3):
            x, y = pad + c * (side + gap), pad + r * (side + gap)
            d.rounded_rectangle([x, y, x + side, y + side], radius=side * 0.18, fill=cells[r][c])
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    logo = Image.open(BRAND / "logo.png").convert("RGBA")
    icon = Image.open(BRAND / "icon.png").convert("RGBA")

    # header logos (40 px tall on screen, exported at 4x for sharp displays)
    hh = 160
    size = (round(logo.width * hh / logo.height), hh)
    logo.resize(size, Image.LANCZOS).save(BRAND / "logo-header.png", optimize=True)
    dark = dark_logo(logo)
    dark.resize(size, Image.LANCZOS).save(BRAND / "logo-header-dark.png", optimize=True)
    dark.resize((logo.width // 4, logo.height // 4), Image.LANCZOS).save(BRAND / "logo-dark.png", optimize=True)

    fit(icon, 64).save(BRAND / "icon-64.png", optimize=True)
    # the full emblem is unreadable at 16/32 px, so the tab icon uses the simplified grid
    small_favicon(32).save(BRAND / "favicon-32.png", optimize=True)
    small_favicon(16).save(BRAND / "favicon-16.png", optimize=True)
    small_favicon(48).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    on_background(fit(icon, 180, 0.9), WHITE).convert("RGB").save(BRAND / "apple-touch-icon.png", optimize=True)
    fit(icon, 192).save(BRAND / "icon-192.png", optimize=True)
    fit(icon, 512).save(BRAND / "icon-512.png", optimize=True)
    on_background(fit(icon, 512, 0.7), NIGHT_NAVY).convert("RGB").save(BRAND / "icon-maskable-512.png", optimize=True)

    og = Image.new("RGBA", (1200, 630), WHITE)
    k = min(1000 / logo.width, 480 / logo.height)
    small = logo.resize((round(logo.width * k), round(logo.height * k)), Image.LANCZOS)
    og.alpha_composite(small, ((1200 - small.width) // 2, (630 - small.height) // 2))
    og.convert("RGB").save(BRAND / "og-image.png", optimize=True)
    print("icons written to", BRAND)


if __name__ == "__main__":
    main()
