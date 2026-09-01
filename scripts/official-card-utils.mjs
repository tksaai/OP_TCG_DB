export function getOfficialVariantRank(card) {
    const rank = Number(card?._sourceVariantIndex);
    return Number.isInteger(rank) && rank >= 0 ? rank : Number.MAX_SAFE_INTEGER;
}

export function preferOfficialCardVariant(existing, candidate) {
    if (!existing) return candidate;
    return getOfficialVariantRank(candidate) < getOfficialVariantRank(existing) ? candidate : existing;
}

export function stripOfficialSyncMetadata(card) {
    const { _sourceVariantIndex, ...cleanCard } = card;
    return cleanCard;
}
