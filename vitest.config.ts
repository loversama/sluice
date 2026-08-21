import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        // These are pure-function tests; nothing here should touch the network.
        environment: "node",
    },
});
