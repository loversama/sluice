/**
 * Matching Steam library titles to Twitch category names.
 *
 * The two catalogues are maintained separately and disagree constantly: Twitch lists
 * "Tom Clancy's Ghost Recon: Wildlands" where Steam has "Tom Clancy's Ghost Recon® Wildlands",
 * and edition suffixes appear on one side only. Normalising both aggressively and then
 * comparing token sets handles nearly all of it without a hand-maintained mapping table.
 */

/** Suffixes Steam adds that never appear in a Twitch category name. */
const EDITION_NOISE = [
    "game of the year edition",
    "definitive edition",
    "enhanced edition",
    "complete edition",
    "deluxe edition",
    "ultimate edition",
    "standard edition",
    "remastered",
    "director's cut",
    "goty",
];

/** Words that carry no distinguishing information when comparing titles. */
const STOP_WORDS = new Set(["the", "a", "an", "of", "and"]);

export function normalizeTitle(title: string): string {
    let value = title.toLowerCase();

    // Strip trademark and copyright marks, which Steam uses and Twitch does not.
    value = value.replace(/[®™©]/g, " ");
    // Unify the various dashes and apostrophes before punctuation is removed.
    value = value.replace(/[‐-―−]/g, "-").replace(/[‘’]/g, "'");

    for (const noise of EDITION_NOISE) {
        value = value.replace(noise, " ");
    }

    // Drop everything that is not a letter, digit or space. Handles ":", "-", "'".
    value = value.replace(/[^\p{L}\p{N}]+/gu, " ");
    return value.replace(/\s+/g, " ").trim();
}

function tokens(title: string): Set<string> {
    return new Set(
        normalizeTitle(title)
            .split(" ")
            .filter((token) => token && !STOP_WORDS.has(token)),
    );
}

/** Digits and roman numerals, which distinguish a sequel from its predecessor. */
const SEQUEL_PATTERN = /^(\d+|i{1,3}|iv|v|vi{1,3}|ix|x)$/;

function sequelMarkers(titleTokens: Set<string>): Set<string> {
    const markers = new Set<string>();
    for (const token of titleTokens) {
        if (SEQUEL_PATTERN.test(token)) {
            markers.add(token);
        }
    }
    return markers;
}

function sameMarkers(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const marker of a) {
        if (!b.has(marker)) {
            return false;
        }
    }
    return true;
}

/**
 * Similarity from 0 to 1, as the proportion of the smaller title's words that also appear in
 * the larger one. Asymmetric containment rather than Jaccard, so that a Twitch category
 * matches a Steam title carrying extra edition words.
 *
 * Sequel numbering is treated as decisive rather than as one word among many: plain
 * containment scores "Counter-Strike" against "Counter-Strike 2" as a perfect match, which
 * would silently rank a campaign against the wrong game.
 */
export function similarity(a: string, b: string): number {
    const left = tokens(a);
    const right = tokens(b);
    if (left.size === 0 || right.size === 0) {
        return 0;
    }
    if (!sameMarkers(sequelMarkers(left), sequelMarkers(right))) {
        return 0;
    }
    let shared = 0;
    for (const token of left) {
        if (right.has(token)) {
            shared++;
        }
    }
    return shared / Math.min(left.size, right.size);
}

export interface MatchCandidate {
    name: string;
}

/**
 * Best match for `twitchName` among `candidates`, or null when nothing is close enough.
 *
 * The threshold is deliberately high: a wrong match silently mis-ranks a campaign, which is
 * worse than not matching at all and falling back to the unowned tier.
 */
export function findBestMatch<T extends MatchCandidate>(
    twitchName: string,
    candidates: T[],
    threshold = 0.85,
): T | null {
    const normalizedTarget = normalizeTitle(twitchName);
    if (!normalizedTarget) {
        return null;
    }

    let best: T | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
        // An exact normalised match is unambiguous; take it immediately.
        if (normalizeTitle(candidate.name) === normalizedTarget) {
            return candidate;
        }
        const score = similarity(twitchName, candidate.name);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }

    return bestScore >= threshold ? best : null;
}
