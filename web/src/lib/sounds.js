/**
 * Audible feedback for the two things worth hearing from across a room: a drop landing,
 * and a campaign finishing.
 *
 * Both sounds are short and quiet by design. This runs for hours in a window nobody is
 * looking at, so anything attention-grabbing would be a nuisance by the third one.
 */

const SOURCES = {
    claim: "/sounds/claim.mp3",
    complete: "/sounds/complete.mp3",
};

/**
 * One element per sound, reused.
 *
 * Created lazily: constructing Audio at module load would start a fetch on every page,
 * including the ones that never play anything.
 */
const players = {};

function elementFor(name) {
    if (!players[name]) {
        const audio = new Audio(SOURCES[name]);
        audio.preload = "auto";
        players[name] = audio;
    }
    return players[name];
}

/**
 * Play one of the sounds, unless sound is off.
 *
 * Never throws and never rejects. Browsers refuse to play audio until the page has been
 * interacted with, so an unattended dashboard will be told no - which is a fact about the
 * browser, not an error worth surfacing, and certainly not one worth breaking a claim
 * handler over.
 */
export function playSound(name, settings) {
    if (!settings?.enabled || !SOURCES[name]) {
        return;
    }

    try {
        const audio = elementFor(name);
        audio.volume = Math.min(1, Math.max(0, Number(settings.volume ?? 0.5)));
        // Rewind, so two claims close together are both audible rather than the second
        // being swallowed while the first is still playing.
        audio.currentTime = 0;
        const started = audio.play();
        if (started?.catch) {
            started.catch(() => {});
        }
    } catch {
        /* An unplayable sound must never interrupt what triggered it. */
    }
}
