from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def iter_images(root: Path):
    for path in root.rglob("*"):
        if path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
            yield path


def convert_image(source: Path, source_root: Path, output_root: Path, quality: int, force: bool) -> str:
    relative = source.relative_to(source_root)
    target = output_root / relative.with_suffix(".webp")

    if target.exists() and not force and target.stat().st_mtime >= source.stat().st_mtime:
        return "skipped"

    target.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        image.save(target, "WEBP", quality=quality, method=6)

    return "converted"


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert card images to WebP.")
    parser.add_argument("--source", default="Cards")
    parser.add_argument("--output", default="CardsWebP")
    parser.add_argument("--quality", type=int, default=76)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    source_root = Path(args.source)
    output_root = Path(args.output)
    counts = {"converted": 0, "skipped": 0, "failed": 0}

    for index, source in enumerate(iter_images(source_root), start=1):
        if args.limit and index > args.limit:
            break
        try:
            result = convert_image(source, source_root, output_root, args.quality, args.force)
            counts[result] += 1
            if result == "converted":
                print(f"[converted] {source}")
        except Exception as error:
            counts["failed"] += 1
            print(f"[failed] {source}: {error}")

    print(counts)
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
