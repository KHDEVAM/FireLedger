"""Check the data color ramps in tokens.css.

1. Sequential "fire ramp": CIELAB lightness must fall steadily from low to high.
2. Every ramp: neighbouring steps must stay distinguishable (CIE76 delta E)
   for normal vision and under simulated deuteranopia, protanopia and tritanopia
   (Machado, Oliveira & Fernandes 2009, severity 1.0).

    python web/scripts/check_ramps.py        # exit code 1 if a check fails
"""
import re
import sys
from pathlib import Path

import numpy as np

TOKENS = Path(__file__).resolve().parents[1] / "src" / "styles" / "tokens.css"
MIN_DELTA_E = 10.0

CVD = {
    "normal": np.eye(3),
    "deuteranopia": np.array([[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]),
    "protanopia": np.array([[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]),
    "tritanopia": np.array([[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]),
}


def tokens() -> dict:
    light = TOKENS.read_text(encoding="utf-8").split(':root[data-theme="dark"]')[0]
    return dict(re.findall(r"(--fl-[\w-]+):\s*(#[0-9a-fA-F]{6})", light))


def linear(hex_color: str) -> np.ndarray:
    rgb = np.array([int(hex_color[i:i + 2], 16) for i in (1, 3, 5)]) / 255
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def lab(rgb_linear: np.ndarray) -> np.ndarray:
    m = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = m @ np.clip(rgb_linear, 0, 1) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def main() -> int:
    t = tokens()
    ramps = {
        "counts (fire ramp)": [t[f"--fl-ramp-{i}"] for i in range(0, 8)],
        "anomaly (diverging)": [t[f"--fl-div-{i}"] for i in range(1, 8)],
        "hotspot age": [t[f"--fl-age-{i}"] for i in range(1, 5)],
    }
    failed = False

    seq = ramps["counts (fire ramp)"]
    light = [lab(linear(c))[0] for c in seq]
    print("fire ramp lightness L*:", " > ".join(f"{v:.0f}" for v in light))
    if any(b >= a for a, b in zip(light, light[1:])):
        print("  FAIL: lightness does not decrease steadily")
        failed = True

    for name, colors in ramps.items():
        print(f"\n{name}: {' '.join(colors)}")
        for vision, matrix in CVD.items():
            labs = [lab(matrix @ linear(c)) for c in colors]
            deltas = [float(np.linalg.norm(a - b)) for a, b in zip(labs, labs[1:])]
            worst = min(deltas)
            ok = worst >= MIN_DELTA_E
            failed |= not ok
            print(f"  {vision:13s} min neighbour dE {worst:5.1f}  {'ok' if ok else 'FAIL'}  ({' '.join(f'{d:.0f}' for d in deltas)})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
