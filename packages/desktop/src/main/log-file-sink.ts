import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";

import { consoleSink, type LogLevel, type LogSink } from "@tdb/core";

/** Past this, the current file is rotated once. Two files, no archive to manage. */
const MAX_BYTES = 5 * 1024 * 1024;

const ANSI = /\x1b\[[0-9;]*m/g;

function render(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
    }
    return inspect(value, { depth: 3, colors: false });
}

/**
 * Write the log to a file, because a packaged Windows app has no console attached.
 *
 * Without this every diagnostic the bot produces is simply lost - including the rotated
 * query-hash error that the troubleshooting docs treat as the first thing to look for.
 * In development the console sink stays on as well, since there it is genuinely useful.
 */
export function createFileSink(directory: string, alsoConsole: boolean): LogSink {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "desktop.log");

    return {
        write(level: LogLevel, args: unknown[]): void {
            if (alsoConsole) {
                consoleSink.write(level, args);
            }
            const line =
                `[${new Date().toISOString()}] ${level.padEnd(5)} ` +
                `${args.map(render).join(" ")}\n`.replace(ANSI, "");
            try {
                try {
                    if (statSync(path).size > MAX_BYTES) {
                        renameSync(path, `${path}.old`);
                    }
                } catch {
                    // No file yet, or a rotation lost a race. Either way, just append.
                }
                appendFileSync(path, line);
            } catch {
                // A log that cannot be written must not take the app down with it.
            }
        },
    };
}

export function logDirectory(dataDir: string): string {
    return join(dataDir, "logs");
}
