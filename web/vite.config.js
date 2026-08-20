import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    // The daemon serves the built output from web/dist.
    build: { outDir: "dist", emptyOutDir: true },
    server: {
        // During `npm run dev`, proxy the API to the running daemon.
        proxy: {
            "/api": { target: "http://127.0.0.1:4400", changeOrigin: true, ws: false },
        },
    },
});
