import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the built dashboard lives, which differs between running from source and running
 * from an installer.
 *
 * Stated here rather than inferred inside the server, which has no business knowing whether
 * it is inside an asar archive. The environment override exists for the same reason it does
 * in the daemon: someone will eventually have a layout neither branch predicted.
 */
export function resolveWebDist(): string {
    const override = process.env.TDB_WEB_DIR;
    if (override) {
        return override;
    }
    if (!app.isPackaged) {
        // __dirname does not exist in an ES module, and this bundle is one.
        // out/main/index.js -> packages/desktop/out/main -> repo root
        const here = dirname(fileURLToPath(import.meta.url));
        return join(here, "..", "..", "..", "..", "web", "dist");
    }
    // Shipped via electron-builder's extraResources, so outside the asar and readable by
    // ordinary file APIs.
    return join(process.resourcesPath, "web");
}
