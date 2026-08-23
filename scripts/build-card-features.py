from __future__ import annotations

import argparse
import base64
import json
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


FEATURE_VERSION = 1
FEATURE_WIDTH = 8
FEATURE_HEIGHT = 11
MIN_LUMA_STDDEV = 12.0


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def normalize_card_type(value: Any) -> str:
    card_type = str(value or "").strip().upper()
    return "LEADER" if card_type == "LEADER" else "DECK"


def build_card_type_map(cards: list[dict[str, Any]], provisional: list[dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for card in [*cards, *provisional]:
        number = str(card.get("cardNumber") or "").strip().upper()
        if number:
            result[number] = normalize_card_type(card.get("cardType"))
    return result


def local_image_path(value: Any) -> Path | None:
    path_value = str(value or "").strip().replace("\\", "/")
    if not path_value or path_value.startswith(("http://", "https://", "data:")):
        return None
    while path_value.startswith("./"):
        path_value = path_value[2:]
    return Path(path_value)


def image_feature(path: Path) -> str:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image = image.resize((FEATURE_WIDTH, FEATURE_HEIGHT), Image.Resampling.LANCZOS)
        pixels = list(image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata())

    lumas = [0.299 * red + 0.587 * green + 0.114 * blue for red, green, blue in pixels]
    mean = sum(lumas) / len(lumas)
    variance = sum((value - mean) ** 2 for value in lumas) / len(lumas)
    scale = 48.0 / max(math.sqrt(variance), MIN_LUMA_STDDEV)

    feature = bytearray()
    for (red, green, blue), luma in zip(pixels, lumas):
        normalized_luma = round(128 + (luma - mean) * scale)
        cb = round(128 - 0.168736 * red - 0.331264 * green + 0.5 * blue)
        cr = round(128 + 0.5 * red - 0.418688 * green - 0.081312 * blue)
        feature.extend((
            max(0, min(255, normalized_luma)),
            max(0, min(255, cb)),
            max(0, min(255, cr)),
        ))
    return base64.b64encode(feature).decode("ascii")


def collect_entries(
    manifest: dict[str, Any],
    provisional: list[dict[str, Any]],
    card_types: dict[str, str],
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for card_number, variants in (manifest.get("cards") or {}).items():
        number = str(card_number or "").strip().upper()
        if not number or not isinstance(variants, list):
            continue
        for fallback_index, variant in enumerate(variants):
            if not isinstance(variant, dict):
                continue
            primary_path = local_image_path(variant.get("path"))
            fallback_path = local_image_path(variant.get("fallbackPath"))
            path = primary_path if primary_path is not None and primary_path.is_file() else fallback_path
            if path is None or not path.is_file():
                continue
            web_path = path.as_posix()
            identity = (number, web_path.lower())
            if identity in seen:
                continue
            seen.add(identity)
            variant_index = variant.get("variantIndex", fallback_index)
            entries.append({
                "n": number,
                "p": web_path,
                "v": int(variant_index) if isinstance(variant_index, (int, float)) else fallback_index,
                "t": normalize_card_type(variant.get("cardType") or card_types.get(number)),
                "_fallback": fallback_path.as_posix()
                if fallback_path is not None and fallback_path.is_file() and fallback_path != path
                else "",
            })

    for fallback_index, card in enumerate(provisional):
        if not isinstance(card, dict):
            continue
        number = str(card.get("cardNumber") or "").strip().upper()
        path = local_image_path(card.get("imagePath"))
        if not number or path is None or not path.is_file():
            continue
        web_path = path.as_posix()
        identity = (number, web_path.lower())
        if identity in seen:
            continue
        seen.add(identity)
        entries.append({
            "n": number,
            "p": web_path,
            "v": 2000 + fallback_index,
            "t": normalize_card_type(card.get("cardType") or card_types.get(number)),
        })

    entries.sort(key=lambda entry: (entry["n"], entry["v"], entry["p"]))
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description="Build compact browser-side card image features.")
    parser.add_argument("--manifest", default="image-manifest.json")
    parser.add_argument("--cards", default="cards.json")
    parser.add_argument("--provisional", default="provisional-cards.json")
    parser.add_argument("--output", default="card-features.json")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    manifest = load_json(Path(args.manifest), {"cards": {}})
    cards = load_json(Path(args.cards), [])
    provisional = load_json(Path(args.provisional), [])
    card_types = build_card_type_map(cards, provisional)
    entries = collect_entries(manifest, provisional, card_types)
    if args.limit > 0:
        entries = entries[: args.limit]

    features: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for index, entry in enumerate(entries, start=1):
        try:
            try:
                feature = image_feature(Path(entry["p"]))
            except Exception:
                fallback_path = entry.get("_fallback")
                if not fallback_path:
                    raise
                feature = image_feature(Path(fallback_path))
            features.append({
                key: value
                for key, value in {**entry, "f": feature}.items()
                if not key.startswith("_")
            })
        except Exception as error:
            failures.append({"path": entry["p"], "error": str(error)})
        if index % 500 == 0:
            print(f"processed {index}/{len(entries)}")

    payload = {
        "version": FEATURE_VERSION,
        "width": FEATURE_WIDTH,
        "height": FEATURE_HEIGHT,
        "channels": "normalized-ycbcr",
        "totalImages": len(features),
        "features": features,
    }
    Path(args.output).write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {args.output}: {len(features)} image features")
    if failures:
        print(json.dumps({"failures": failures[:20], "failureCount": len(failures)}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
