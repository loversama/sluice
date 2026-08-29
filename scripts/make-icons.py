#!/usr/bin/env python3
"""
Build every icon Sluice ships from one source drawing.

The source is a flat purple mark on a white background, so the background comes off by
coverage rather than by a colour-distance threshold: each pixel of a mark drawn on white is
`alpha * purple + (1 - alpha) * white`, which rearranges to give the alpha that produced it.
Recolouring to the flat purple afterwards leaves antialiased edges clean, where a plain
"make white pixels transparent" pass would leave a pale fringe all the way round.

Run it after changing sluice.jpeg:

    python3 scripts/make-icons.py
"""

from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "sluice.jpeg"
DESKTOP = ROOT / "packages" / "desktop" / "resources"
WEB = ROOT / "web" / "public"

PURPLE = (99, 56, 171)

# The darkest channel of the mark. Coverage is measured against it, so it sets the scale.
DARKEST = min(PURPLE)

# JPEG leaves the white background a shade off pure white. Without this floor the background
# carries roughly 1% alpha everywhere, which is invisible on screen and very visible as a
# grey wash the first time something composites the icon over a light surface.
NOISE_FLOOR = 0.05

# The same artefacts leave the mark's solid interior a shade off full coverage - about 99%,
# which no one can see but which means the icon has no fully opaque pixels at all. Coverage
# above this counts as solid.
SOLID_CEILING = 0.95

# Icons read as too small when the mark runs to the edge, because every OS puts them in a
# grid of icons that leave a margin of their own. This is the fraction of the canvas left
# empty. The tray gets far less of one: it is drawn at 16px inside an already tight slot,
# and margin there is the difference between a recognisable mark and a smudge.
APP_MARGIN = 0.08
TRAY_MARGIN = 0.02

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# NSIS wizard art. The sidebar is a fixed size and must be a BMP: without one the installer
# falls back to nsis3-metro.bmp, a stock NSIS graphic with nothing to do with this app.
SIDEBAR = (164, 314)

# The background the sidebar mark sits on, matched to the app's own dark surface.
SIDEBAR_BACKGROUND = (24, 24, 27)


def coverage(source: Image.Image) -> Image.Image:
    """The source's alpha channel, recovered from how far each pixel sits from white."""
    rgb = source.convert("RGB")
    # The darkest channel carries the most contrast against white, so it gives the least
    # noisy estimate of coverage.
    red, green, blue = rgb.split()
    darkest = ImageChops.darker(ImageChops.darker(red, green), blue)
    span = 255 - DARKEST

    def to_alpha(value: int) -> int:
        alpha = (255 - value) / span
        alpha = (alpha - NOISE_FLOOR) / (SOLID_CEILING - NOISE_FLOOR)
        return round(255 * min(1.0, max(0.0, alpha)))

    return darkest.point([to_alpha(v) for v in range(256)])


def square(alpha: Image.Image, margin: float) -> Image.Image:
    """The mark, trimmed of its whitespace and centred on a square canvas with a margin."""
    box = alpha.getbbox()
    if box is None:
        raise SystemExit(f"{SOURCE} looks blank once the background is removed")
    mark = alpha.crop(box)

    side = round(max(mark.size) / (1 - 2 * margin))
    canvas = Image.new("L", (side, side), 0)
    canvas.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2))
    return canvas


def coloured(alpha: Image.Image, colour: tuple[int, int, int], size: int) -> Image.Image:
    """A flat-coloured mark at one size, shaped by the alpha channel."""
    scaled = alpha.resize((size, size), Image.LANCZOS)
    image = Image.new("RGBA", (size, size), (*colour, 0))
    image.putalpha(scaled)
    return image


def write_sidebar(path: Path, alpha: Image.Image) -> None:
    """The installer's side panel: the mark centred on a flat background, saved as a BMP."""
    panel = Image.new("RGB", SIDEBAR, SIDEBAR_BACKGROUND)
    side = round(min(SIDEBAR) * 0.62)
    mark = coloured(alpha, PURPLE, side)
    # Composited rather than pasted with a mask alone, so the antialiased edges blend into
    # the panel instead of against black.
    panel.paste(mark, ((SIDEBAR[0] - side) // 2, (SIDEBAR[1] - side) // 2), mark)
    path.parent.mkdir(parents=True, exist_ok=True)
    panel.save(path, "BMP")
    print(f"  {path.relative_to(ROOT)}")


def write(path: Path, image: Image.Image, sizes: list[int] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if sizes:
        image.save(path, sizes=[(s, s) for s in sizes])
    else:
        image.save(path)
    print(f"  {path.relative_to(ROOT)}")


def main() -> None:
    mark = coverage(Image.open(SOURCE))
    alpha = square(mark, APP_MARGIN)
    tray = square(mark, TRAY_MARGIN)
    print(f"{SOURCE.name} -> {alpha.width}px mark")

    # The application itself, in its own colour.
    write(DESKTOP / "icon.png", coloured(alpha, PURPLE, 1024))
    write(DESKTOP / "icon.ico", coloured(alpha, PURPLE, 256), ICO_SIZES)

    # The tray. White for a dark taskbar, which is what Windows ships by default; the purple
    # one is kept for a light taskbar, where white would be invisible.
    write(DESKTOP / "tray-light.ico", coloured(tray, (255, 255, 255), 256), ICO_SIZES)
    write(DESKTOP / "tray-dark.ico", coloured(tray, PURPLE, 256), ICO_SIZES)

    # The installer wizard. The header icon appears beside every page's title; the sidebar
    # is the tall panel on the welcome and finish pages.
    write(DESKTOP / "installerHeaderIcon.ico", coloured(alpha, PURPLE, 256), ICO_SIZES)
    write_sidebar(DESKTOP / "installerSidebar.bmp", alpha)

    # The dashboard, which the container serves to a browser as well.
    write(WEB / "favicon.ico", coloured(alpha, PURPLE, 256), [16, 32, 48])
    write(WEB / "icon-192.png", coloured(alpha, PURPLE, 192))
    write(WEB / "icon-512.png", coloured(alpha, PURPLE, 512))


if __name__ == "__main__":
    main()
