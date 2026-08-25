/**
 * Whether a URL is one of ours, and therefore belongs inside the window.
 *
 * Everything else goes to the real browser: signing in to Twitch or Steam should happen
 * somewhere the address bar is visible and a password manager works, not in a chromeless
 * window that merely looks like this app.
 *
 * A pure function so it can be tested without standing up Electron - the interesting cases
 * are all string handling, and getting one wrong either traps an OAuth page inside the app
 * or throws the dashboard out of it.
 */
export function isOwnUrl(url: string, port: number): boolean {
    if (!port) {
        return false;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    // Compared with the port: a different service on loopback is not us. http only, since
    // that is what we serve - an https URL claiming our host is not something we issued.
    return parsed.protocol === "http:" && parsed.host === `127.0.0.1:${port}`;
}
