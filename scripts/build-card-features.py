from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


FEATURE_VERSION = 1
FEATURE_WIDTH = 12
FEATURE_HEIGHT = 17
FEATURE_CHANNELS = "normalized-ycbcr"
FEATURE_CACHE_VERSION = 1
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


def entry_identity(entry: dict[str, Any]) -> str:
    return f'{entry["n"]}\t{str(entry["p"]).lower()}'


def entry_digest(entry: dict[str, Any]) -> str:
    digest = hashlib.sha256()
    for key in ("p", "_fallback"):
        path_value = entry.get(key)
        if not path_value:
            continue
        path = Path(path_value)
        digest.update(key.encode("ascii"))
        digest.update(b"\0")
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def valid_feature(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        return False
    return len(decoded) == FEATURE_WIDTH * FEATURE_HEIGHT * 3


def compatible_feature_payload(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("version") == FEATURE_VERSION
        and payload.get("width") == FEATURE_WIDTH
        and payload.get("height") == FEATURE_HEIGHT
        and payload.get("channels") == FEATURE_CHANNELS
        and isinstance(payload.get("features"), list)
    )


def compatible_cache_payload(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("cacheVersion") == FEATURE_CACHE_VERSION
        and payload.get("featureVersion") == FEATURE_VERSION
        and payload.get("width") == FEATURE_WIDTH
        and payload.get("height") == FEATURE_HEIGHT
        and payload.get("channels") == FEATURE_CHANNELS
        and isinstance(payload.get("entries"), dict)
    )


def write_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


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
    parser.add_argument("--cache", default="card-feature-cache.json")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    manifest = load_json(Path(args.manifest), {"cards": {}})
    cards = load_json(Path(args.cards), [])
    provisional = load_json(Path(args.provisional), [])
    output_path = Path(args.output)
    cache_path = Path(args.cache)
    previous_payload = load_json(output_path, {})
    previous_cache = load_json(cache_path, {})
    can_reuse = (
        not args.force
        and compatible_feature_payload(previous_payload)
        and compatible_cache_payload(previous_cache)
    )
    previous_features = {
        entry_identity(entry): entry
        for entry in previous_payload.get("features", [])
        if isinstance(entry, dict) and entry.get("n") and entry.get("p")
    } if can_reuse else {}
    previous_digests = previous_cache.get("entries", {}) if can_reuse else {}
    card_types = build_card_type_map(cards, provisional)
    entries = collect_entries(manifest, provisional, card_types)
    if args.limit > 0:
        entries = entries[: args.limit]

    features: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    next_digests: dict[str, str] = {}
    generated = 0
    reused = 0
    for index, entry in enumerate(entries, start=1):
        try:
            identity = entry_identity(entry)
            digest = entry_digest(entry)
            previous = previous_features.get(identity)
            if previous_digests.get(identity) == digest and valid_feature(previous.get("f") if previous else None):
                feature = previous["f"]
                reused += 1
            else:
                try:
                    feature = image_feature(Path(entry["p"]))
                except Exception:
                    fallback_path = entry.get("_fallback")
                    if not fallback_path:
                        raise
                    feature = image_feature(Path(fallback_path))
                generated += 1
            next_digests[identity] = digest
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
        "channels": FEATURE_CHANNELS,
        "totalImages": len(features),
        "features": features,
    }
    cache_payload = {
        "cacheVersion": FEATURE_CACHE_VERSION,
        "featureVersion": FEATURE_VERSION,
        "width": FEATURE_WIDTH,
        "height": FEATURE_HEIGHT,
        "channels": FEATURE_CHANNELS,
        "entries": next_digests,
    }
    removed = len(set(previous_features) - set(next_digests)) if can_reuse else 0
    write_json(output_path, payload)
    write_json(cache_path, cache_payload)
    print(json.dumps({
        "total": len(features),
        "generated": generated,
        "reused": reused,
        "removed": removed,
        "failures": len(failures),
        "forced": args.force,
    }, ensure_ascii=False))
    print(f"Wrote {args.output}: {len(features)} image features")
    if failures:
        print(json.dumps({"failures": failures[:20], "failureCount": len(failures)}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
