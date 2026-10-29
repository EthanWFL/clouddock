"""Render the CloudDock icon and its logical-size optical variants."""

from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
# Keep the historical source filename as a tracked, human-viewable preview.
# The deterministic geometry and colors below are the source of truth.
SOURCE_PREVIEW = BUILD / "clouddock-icon-source.png"
ICONSET = BUILD / "AppIcon.iconset"
MASTER_SIZE = 1024
DESIGN_SIZE = 1024
BACKGROUND = "#14788C"
FOREGROUND = "#F7F8F3"
AQUA = "#58CEC9"

# The 16 pt and 32 pt representations use optical variants based on their
# logical size. A 16 pt @2x icon must not share the 32 pt @1x artwork merely
# because both files happen to contain 32 pixels.
ICON_SIZES = {
    "icon_16x16.png": (16, "tiny"),
    "icon_16x16@2x.png": (32, "tiny"),
    "icon_32x32.png": (32, "compact"),
    "icon_32x32@2x.png": (64, "compact"),
    "icon_128x128.png": (128, "standard"),
    "icon_128x128@2x.png": (256, "standard"),
    "icon_256x256.png": (256, "standard"),
    "icon_256x256@2x.png": (512, "standard"),
    "icon_512x512.png": (512, "standard"),
    "icon_512x512@2x.png": (1024, "standard"),
}


def render_icon(size: int, variant: str = "standard") -> Image.Image:
    supersample = 8 if size <= 64 else 4 if size <= 256 else 2
    canvas_size = size * supersample
    scale = canvas_size / DESIGN_SIZE

    def point(value: float) -> int:
        return round(value * scale)

    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        (point(8), point(8), point(1016), point(1016)),
        radius=point(205),
        fill=BACKGROUND,
    )

    geometries = {
        "standard": {
            "frame": (212, 230, 812, 794, 112),
            "primary": (294, 330, 472, 694, 42),
            "secondary_top": (500, 330, 730, 492, 38),
            "secondary_bottom": (500, 532, 730, 694, 38),
        },
        "compact": {
            "frame": (196, 214, 828, 810, 116),
            "primary": (286, 316, 478, 708, 43),
            "secondary_top": (516, 316, 744, 490, 40),
            "secondary_bottom": (516, 534, 744, 708, 40),
        },
        "tiny": {
            "frame": (176, 194, 848, 830, 120),
            "primary": (272, 296, 472, 728, 42),
            "secondary_top": (536, 296, 760, 488, 40),
            "secondary_bottom": (536, 536, 760, 728, 40),
        },
    }
    geometry = geometries[variant]

    for name, color in (
        ("frame", FOREGROUND),
        ("primary", AQUA),
        ("secondary_top", BACKGROUND),
        ("secondary_bottom", BACKGROUND),
    ):
        left, top, right, bottom, radius = geometry[name]
        draw.rounded_rectangle(
            (point(left), point(top), point(right), point(bottom)),
            radius=point(radius),
            fill=color,
        )

    if image.size != (size, size):
        image = image.resize((size, size), Image.Resampling.LANCZOS)
    return image


def save_source_preview(master: Image.Image) -> None:
    preview = Image.new("RGB", master.size, "white")
    preview.paste(master, mask=master.getchannel("A"))
    preview.save(SOURCE_PREVIEW, format="PNG", optimize=True)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    ICONSET.mkdir(parents=True, exist_ok=True)

    master = render_icon(MASTER_SIZE)
    save_source_preview(master)
    master.save(BUILD / "icon-1024.png", format="PNG", optimize=True)

    for filename, (size, variant) in ICON_SIZES.items():
        icon = render_icon(size, variant=variant)
        icon.save(ICONSET / filename, format="PNG", optimize=True)

    iconutil = shutil.which("iconutil")
    if iconutil:
        subprocess.run(
            [iconutil, "--convert", "icns", "--output", str(BUILD / "AppIcon.icns"), str(ICONSET)],
            check=True,
        )
    else:
        print("iconutil not found; generated PNG and AppIcon.iconset assets only")


if __name__ == "__main__":
    main()
