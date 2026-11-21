#!/usr/bin/env python3
"""Import DON!! card artwork from the official DON!! card list PDF.

The official card search does not expose DON!! cards. This importer crops the
cards from Bandai's dedicated PDF, assigns stable synthetic DON-### IDs, and
merges them into the app's card database. Existing IDs are matched by a small
perceptual hash so page insertions in later PDF revisions do not move a user's
collection counts to a different design.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image

try:
    from pypdf import PdfReader
except ImportError as error:  # pragma: no cover - dependency message for operators
    raise RuntimeError("pypdf is required: python -m pip install pypdf pillow") from error


ROOT = Path(__file__).resolve().parent.parent
PDF_URL = "https://www.onepiece-cardgame.com/pdf/don-cardlist.pdf"
CARDS_PATH = ROOT / "cards.json"
SERIES_PATH = ROOT / "series-master.json"
SOURCES_PATH = ROOT / "don-card-sources.json"
OUTPUT_DIR = ROOT / "CardsWebP" / "DON" / "official"

HASH_DISTANCE_LIMIT = 12


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync official DON!! cards")
    parser.add_argument("--pdf", type=Path, help="Use a previously downloaded PDF")
    parser.add_argument("--quality", type=int, default=84)
    parser.add_argument("--reset-ids", action="store_true", help="Reassign every synthetic ID")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def download_pdf(target: Path) -> None:
    request = urllib.request.Request(
        PDF_URL,
        headers={"User-Agent": "OP_TCG_DB DON card sync (+https://github.com/tksaai/OP_TCG_DB)"},
    )
    with urllib.request.urlopen(request, timeout=90) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)


def difference_hash(image: Image.Image) -> str:
    sample = image.convert("L").resize((17, 16), Image.Resampling.LANCZOS)
    pixels = list(sample.getdata())
    bits = []
    for row in range(16):
        offset = row * 17
        bits.extend(pixels[offset + column] > pixels[offset + column + 1] for column in range(16))
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:064x}"


def hash_distance(left: str, right: str) -> int:
    try:
        return (int(left, 16) ^ int(right, 16)).bit_count()
    except (TypeError, ValueError):
        return 10_000


def card_number_index(card_number: str) -> int:
    match = re.fullmatch(r"DON-(\d+)", str(card_number or ""))
    return int(match.group(1)) if match else 0


def card_sort_key(card: dict) -> tuple:
    card_number = str(card.get("cardNumber", ""))
    parts = re.split(r"(\d+)", card_number)
    return tuple(int(part) if part.isdigit() else part for part in parts)


def pdf_image_index(name: str) -> int:
    match = re.search(r"(\d+)", str(name or ""))
    return int(match.group(1)) if match else 0


def extract_page_cards(page) -> list[Image.Image]:
    candidates = []
    for embedded in page.images:
        image = embedded.image
        width, height = image.size
        aspect_ratio = width / height if height else 0
        if 300 <= width < 1000 and 400 <= height < 1400 and 0.68 <= aspect_ratio <= 0.75:
            candidates.append((pdf_image_index(embedded.name), image.convert("RGBA")))
    return [image for _, image in sorted(candidates, key=lambda item: item[0])]


def make_card(card_number: str, page: int, slot: int) -> dict:
    return {
        "uniqueId": f"{card_number}_official-don-list",
        "cardNumber": card_number,
        "cardName": "ドン!!カード",
        "furigana": "ドンカード",
        "rarity": "-",
        "cardType": "DON!!",
        "color": [],
        "costLifeType": "",
        "costLifeValue": "-",
        "power": "-",
        "counter": "-",
        "attribute": "-",
        "features": [],
        "block": "-",
        "effectText": "自分のターン +1000",
        "trigger": "",
        "getInfo": "公式ドン!!カードリスト",
        "seriesTitle": "ドン!!カード",
        "seriesCode": "DON",
        "imagePath": f"CardsWebP/DON/official/{card_number}.webp",
        "sourcePage": page,
        "sourceSlot": slot,
    }


def assign_card_number(
    image_hash: str,
    page: int,
    slot: int,
    existing_entries: list[dict],
    used_numbers: set[str],
    next_index: int,
) -> tuple[str, int]:
    same_position = next(
        (
            entry
            for entry in existing_entries
            if entry.get("page") == page
            and entry.get("slot") == slot
            and entry.get("cardNumber") not in used_numbers
        ),
        None,
    )
    if same_position and hash_distance(image_hash, same_position.get("hash")) <= HASH_DISTANCE_LIMIT:
        return str(same_position["cardNumber"]), next_index

    candidates = [
        (hash_distance(image_hash, entry.get("hash")), entry)
        for entry in existing_entries
        if entry.get("cardNumber") not in used_numbers
    ]
    if candidates:
        distance, closest = min(candidates, key=lambda item: item[0])
        if distance <= HASH_DISTANCE_LIMIT:
            return str(closest["cardNumber"]), next_index

    card_number = f"DON-{next_index:03d}"
    return card_number, next_index + 1


def sync_cards(args: argparse.Namespace) -> dict:
    existing_sources = load_json(SOURCES_PATH, {})
    existing_entries = existing_sources.get("entries", []) if isinstance(existing_sources, dict) else []
    existing_entries = [entry for entry in existing_entries if isinstance(entry, dict)]
    if args.reset_ids:
        existing_entries = []
    next_index = max((card_number_index(entry.get("cardNumber")) for entry in existing_entries), default=0) + 1
    used_numbers: set[str] = set()
    active_entries: list[dict] = []
    rendered_cards: list[tuple[dict, Image.Image]] = []

    with tempfile.TemporaryDirectory(prefix="op-tcg-don-") as temp_dir_value:
        temp_dir = Path(temp_dir_value)
        pdf_path = args.pdf.resolve() if args.pdf else temp_dir / "don-cardlist.pdf"
        if not args.pdf:
            download_pdf(pdf_path)
        if not pdf_path.is_file():
            raise FileNotFoundError(pdf_path)

        pdf_digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
        reader = PdfReader(pdf_path)
        for page_number, page in enumerate(reader.pages, start=1):
            for slot, embedded_image in enumerate(extract_page_cards(page), start=1):
                normalized = embedded_image.resize((600, 838), Image.Resampling.LANCZOS)
                image_hash = difference_hash(normalized)
                card_number, next_index = assign_card_number(
                    image_hash,
                    page_number,
                    slot,
                    existing_entries,
                    used_numbers,
                    next_index,
                )
                used_numbers.add(card_number)
                entry = {
                    "cardNumber": card_number,
                    "hash": image_hash,
                    "page": page_number,
                    "slot": slot,
                    "active": True,
                }
                active_entries.append(entry)
                rendered_cards.append((make_card(card_number, page_number, slot), normalized.copy()))
            print(f"Extracted page {page_number}/{len(reader.pages)}", flush=True)

        if len(rendered_cards) < 200:
            raise RuntimeError(f"Only {len(rendered_cards)} DON!! cards were detected; refusing to replace data.")

        inactive_entries = [
            {**entry, "active": False}
            for entry in existing_entries
            if entry.get("cardNumber") not in used_numbers
        ]
        all_source_entries = sorted(
            [*active_entries, *inactive_entries], key=lambda entry: card_number_index(entry.get("cardNumber"))
        )
        source_payload = {
            "version": 1,
            "source": PDF_URL,
            "sourcePdfSha256": pdf_digest,
            "cardCount": len(rendered_cards),
            "entries": all_source_entries,
        }

        if args.dry_run:
            return source_payload

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        for card, image in rendered_cards:
            output_path = ROOT / card["imagePath"]
            image.save(output_path, "WEBP", quality=args.quality, method=4)

        for entry in inactive_entries:
            stale_number = str(entry.get("cardNumber", ""))
            if stale_number:
                (OUTPUT_DIR / f"{stale_number}.webp").unlink(missing_ok=True)
        for stale_path in OUTPUT_DIR.glob("DON-*.webp"):
            if stale_path.stem not in used_numbers:
                stale_path.unlink()

        existing_cards = load_json(CARDS_PATH, [])
        cards_without_don = [
            card
            for card in existing_cards
            if not (isinstance(card, dict) and str(card.get("cardType", "")).upper() == "DON!!")
        ]
        merged_cards = sorted(
            [*cards_without_don, *(card for card, _ in rendered_cards)], key=card_sort_key
        )
        write_json(CARDS_PATH, merged_cards)
        write_json(SOURCES_PATH, source_payload)

        series_master = load_json(SERIES_PATH, {"version": 1, "entries": {}})
        entries = series_master.setdefault("entries", {})
        entries["DON"] = {
            "code": "DON",
            "title": "ドン!!カード",
            "label": "ドン!!カード",
        }
        series_master["entries"] = dict(sorted(entries.items()))
        write_json(SERIES_PATH, series_master)
        return source_payload


def main() -> int:
    args = parse_args()
    if not 1 <= args.quality <= 100:
        raise ValueError("--quality must be between 1 and 100")
    result = sync_cards(args)
    mode = "Dry run" if args.dry_run else "Updated"
    print(f"{mode}: {result['cardCount']} DON!! cards from {result['source']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
