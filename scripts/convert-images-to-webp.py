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


def prune_orphans(source_root: Path, output_root: Path, force: bool) -> int:
    """元画像が無くなった WebP を削除する。

    Cards/ はリポジトリに置かず同期時の一時ファイルとして扱うため、
    元画像が手元に無い状態で実行すると全消しになりかねない。
    そのため「元画像が 1 枚も無い」「削除対象が全体の 20% を超える」場合は
    --force-prune が無いかぎり中止する。
    """
    if not output_root.exists():
        return 0

    source_stems = {path.relative_to(source_root).with_suffix("") for path in iter_images(source_root)}         if source_root.exists() else set()
    targets = list(output_root.rglob("*.webp"))
    if not source_stems:
        print("[prune] 元画像が 1 枚も無いのでスキップします")
        return 0

    orphans = [t for t in targets if t.relative_to(output_root).with_suffix("") not in source_stems]
    if not orphans:
        print("[prune] 削除対象はありません")
        return 0

    ratio = len(orphans) / max(len(targets), 1)
    if ratio > 0.2 and not force:
        print(f"[prune] 削除対象が多すぎます ({len(orphans)}/{len(targets)})。"
              " 意図した削除なら --force-prune を付けてください")
        return 0

    for target in orphans:
        target.unlink()
        print(f"[pruned] {target}")
    return len(orphans)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert card images to WebP.")
    parser.add_argument("--source", default="Cards")
    parser.add_argument("--output", default="CardsWebP")
    parser.add_argument("--quality", type=int, default=76)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--prune", action="store_true",
                        help="元画像が無くなった WebP を削除する")
    parser.add_argument("--force-prune", action="store_true",
                        help="削除対象が多くても中止しない")
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

    if args.prune:
        counts["pruned"] = prune_orphans(source_root, output_root, args.force_prune)

    print(counts)
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
