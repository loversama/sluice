import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

/**
 * Main and preload. There is deliberately no renderer target:
 * the dashboard is the same Vue app the Docker build ships, served over loopback HTTP by
 * our own server, so it is built once in web/ and consumed by both distributions - and it
 * needs nothing from Node for the mining features. The preload exists only for the few
 * things that are about this machine rather than the account: run at login, hide to tray,
 * open the log folder.
 */
export default defineConfig({
    // A sandboxed preload must be CommonJS, and this package is ESM - so the preload is
    // built to .cjs explicitly rather than giving up sandboxing to keep the formats aligned.
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: { index: resolve(__dirname, "src/main/index.ts") },
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: { index: resolve(__dirname, "src/preload/index.ts") },
                output: {
                    format: "cjs",
                    entryFileNames: "index.cjs",
                },
            },
        },
    },
});
