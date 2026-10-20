/** Single source of the version, shared by the dashboard and outbound User-Agents. */
export const VERSION = "0.4.12";

/**
 * Which build is talking to the Steam broker, sent as `X-Sluice-Client`.
 *
 * This is cohort control, not a secret, and it is worth being blunt about the difference.
 * It ships inside a desktop application: anyone who wants the string can read it out of the
 * bundle in a minute, and signing it, obfuscating it or fetching it at runtime would only
 * make that take five. What it buys is the ability to stop serving one release - the broker
 * keeps the newest three tokens and answers 426 to anything older, so a build that turns
 * out to hammer Steam can be cut off without waiting for everyone to update. The controls
 * that actually hold are on the broker's side: a per-IP rate limit and a shared cache,
 * which apply whatever token arrives.
 *
 * Never log it. A token in a log pasted into an issue is how a whole cohort ends up
 * revoked over one user's bug report.
 *
 * Development and container builds send "dev", which the broker treats as its own cohort.
 * The release workflow rewrites the literal below, so keep it a plain single-line string
 * assignment - that substitution is a one-line replace and should stay one.
 */
export const CLIENT_TOKEN = "dev";

/**
 * The token to send, letting a run from source borrow a real one.
 *
 * A development build ships "dev", which the broker has never issued, so linking Steam from
 * source ends in a 426 and the app advising the user to update - advice a developer cannot
 * take, because no release exists that would help. Setting SLUICE_CLIENT_TOKEN lets a source
 * run present an issued token without one being committed.
 *
 * Safe to pass around: it is not a credential, and an identical value ships inside every
 * installer. Read here rather than in version.ts's literal above, which the release workflow
 * rewrites by exact text and must stay a plain one-line assignment.
 */
export function clientToken(): string {
    const supplied = process.env.SLUICE_CLIENT_TOKEN?.trim();
    return supplied ? supplied : CLIENT_TOKEN;
}
