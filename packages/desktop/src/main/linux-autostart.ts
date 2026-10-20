import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Starting at login on Linux, by the XDG autostart convention: a desktop entry in
 * ~/.config/autostart that every mainstream desktop reads at login.
 *
 * Electron's own setLoginItemSettings does nothing on Linux, so this is ours to own. Kept
 * free of Electron so it can be tested with a temporary directory standing in for home.
 */

/** Where the entry lives. XDG_CONFIG_HOME only counts when absolute, as the spec says. */
export function autostartFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
    return join(configHome, "autostart", "sluice.desktop");
}

/**
 * Whether a path can be written into Exec= without escaping.
 *
 * Inside double quotes the desktop entry spec gives `"`, backtick, `$` and backslash
 * special meanings, and a line break would end the key. Escaping them is possible, but no
 * real install path contains one, so refusing is simpler than getting a rule wrong and
 * having a login run something other than Sluice.
 */
export function isSafeExecPath(path: string): boolean {
    return isAbsolute(path) && !/["`$\\\r\n]/.test(path);
}

/** The entry itself. `%` is the field-code character, so a literal one is doubled. */
export function desktopEntry(execPath: string): string {
    return [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Sluice",
        "Comment=Mine Twitch drops in the background",
        `Exec="${execPath.replace(/%/g, "%%")}" --hidden`,
        "Icon=sluice",
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
    ].join("\n");
}

/**
 * Write or remove the entry. Returns why nothing was written, or null when it is in place.
 *
 * Run at every start, not just when the toggle changes: an AppImage updates by replacing
 * itself under a new file name, and rewriting the entry here is what keeps the next login
 * pointing at the file that exists rather than the one that was there before the update.
 */
export function applyLinuxAutostart(
    enabled: boolean,
    execPath: string,
    file: string = autostartFile(),
): string | null {
    if (!enabled) {
        rmSync(file, { force: true });
        return null;
    }
    if (!isSafeExecPath(execPath)) {
        return `the path ${JSON.stringify(execPath)} cannot be written into a desktop entry safely`;
    }
    const entry = desktopEntry(execPath);
    // Left alone when already right, so a start does not touch the file for nothing.
    if (existsSync(file) && readFileSync(file, "utf8") === entry) {
        return null;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry);
    return null;
}
