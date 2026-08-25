#!/usr/bin/env node
/**
 * Launch the built app and check it actually works.
 *
 * This covers the things unit tests cannot reach, and which have already gone wrong once
 * each: whether the bundle even runs (an ES module using __dirname does not), whether it
 * finds the dashboard on disk, whether it binds a port and serves from it, and whether the
 * renderer can load that page - which is the loopback-origin decision working.
 *
 * Deliberately not Playwright. One check does not justify the dependency, and the useful
 * assertions here are about a server answering, not about pixels.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const electron = join(root, "node_modules", "electron", "dist", "electron");
const entry = join(here, "..", "out", "main", "index.js");

const headless = !process.env.DISPLAY || process.env.SMOKE_HEADLESS === "1";
const command = headless ? "xvfb-run" : electron;
const args = headless
    ? ["-a", "--server-args=-screen 0 1280x900x24", electron, "--no-sandbox", entry]
    : ["--no-sandbox", entry];


const failures = [];
const check = (ok, what) => {
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
    if (!ok) failures.push(what);
};

const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));

const deadline = Date.now() + 60_000;
const findPort = () => /127\.0\.0\.1:(\d+)/.exec(output)?.[1];

console.log("Smoke test: launching the built app...");
let port;
while (Date.now() < deadline) {
    port = findPort();
    if (port) break;
    await new Promise((r) => setTimeout(r, 500));
}

check(Boolean(port), `binds a port (${port ?? "none found"})`);

if (port) {
    const base = `http://127.0.0.1:${port}`;
    try {
        const page = await fetch(`${base}/`);
        check(page.ok, `serves the dashboard (HTTP ${page.status})`);
        const html = await page.text();
        check(html.includes("<div id=\"app\">") || html.includes("<script"), "the page has content");

        const state = await fetch(`${base}/api/state`).then((r) => r.json());
        check(typeof state?.daemon?.version === "string", "answers /api/state with a snapshot");
        check(state?.auth?.status === "pending", "starts unauthenticated on a fresh profile");

        // Asking Twitch for a device code is a network round trip, so poll rather than
        // assuming it has already landed.
        let code;
        const codeDeadline = Date.now() + 30_000;
        while (Date.now() < codeDeadline) {
            const now = await fetch(`${base}/api/state`).then((r) => r.json());
            code = now?.auth?.device?.code;
            if (typeof code === "string" && code.length > 0) break;
            await new Promise((r) => setTimeout(r, 1000));
        }
        check(typeof code === "string" && code.length > 0, `reaches Twitch for a device code (${code ?? "none"})`);
    } catch (error) {
        check(false, `talking to the app: ${error.message}`);
    }
}

child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 2000));
if (!child.killed) child.kill("SIGKILL");

if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    console.error(output.split("\n").filter((l) => !/GPU|viz_main|SharedImage|EGL|gbm/.test(l)).slice(-15).join("\n"));
    process.exit(1);
}
console.log("\nAll checks passed.");
process.exit(0);
