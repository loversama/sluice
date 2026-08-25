import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

/**
 * Main process only. There is deliberately no renderer target and no preload:
 * the dashboard is the same Vue app the Docker build ships, served over loopback HTTP by
 * our own server, so it is built once in web/ and consumed by both distributions - and it
 * needs nothing from Node, so there is nothing for a preload to expose.
 */
export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: { index: resolve(__dirname, "src/main/index.ts") },
            },
        },
    },
});
