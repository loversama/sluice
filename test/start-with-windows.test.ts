import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Starting with Windows is the difference between a miner that runs and one that runs when
 * you remember to open it, so it is on by default - and it has to actually happen. Electron
 * accepts setLoginItemSettings without complaint in situations where Windows then ignores
 * it, which is how an app ends up with a switch that means nothing.
 *
 * The module cannot be imported here: it pulls in electron, which needs a real app. So this
 * reads the source, in the manner of the application-id test next door.
 */
const source = readFileSync("packages/desktop/src/main/desktop-settings.ts", "utf8");

describe("starting with Windows", () => {
    it("is on unless the user has said otherwise", () => {
        const defaults = /const DEFAULTS: DesktopSettings = \{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
        expect(defaults).toMatch(/runAtLogin:\s*true/);
    });

    it("never registers a run from source", () => {
        // process.execPath is Electron's own binary then, so Windows would launch a bare
        // Electron at every login from a path inside node_modules.
        expect(source).toMatch(/if \(!app\.isPackaged\)/);
    });

    it("names the executable rather than leaving it implicit", () => {
        expect(source).toMatch(/path:\s*process\.execPath/);
    });

    it("starts into the tray rather than in front of the user", () => {
        expect(source).toMatch(/args:\s*\["--hidden"\]/);
        // ...and the main process has to honour that flag, or it starts up visible anyway.
        const main = readFileSync("packages/desktop/src/main/index.ts", "utf8");
        expect(main).toMatch(/process\.argv\.includes\("--hidden"\)/);
    });

    it("checks Windows actually did it", () => {
        expect(source).toContain("getLoginItemSettings()");
    });
});
