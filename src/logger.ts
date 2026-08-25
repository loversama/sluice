const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

export type LogLevel = keyof typeof LEVELS;

const COLORS: Record<LogLevel, string> = {
    error: "\x1b[31m",
    warn: "\x1b[33m",
    info: "\x1b[36m",
    debug: "\x1b[90m",
};

/**
 * Where log lines end up.
 *
 * A packaged desktop app has no console to write to, so the destination has to be the
 * host's choice rather than a fixed one. Core code keeps calling `logger.info(...)` and
 * never learns where the line went.
 */
export interface LogSink {
    write(level: LogLevel, args: unknown[]): void;
}

/** The default: coloured lines on the terminal, warnings and errors on stderr. */
export const consoleSink: LogSink = {
    write(level, args) {
        const time = new Date().toISOString().slice(11, 19);
        const prefix = `\x1b[90m[${time}]\x1b[0m ${COLORS[level]}${level.padEnd(5)}\x1b[0m`;
        const stream = level === "error" || level === "warn" ? console.error : console.log;
        stream(prefix, ...args);
    },
};

let currentLevel: LogLevel = "info";
let sink: LogSink = consoleSink;

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

export function setLogSink(next: LogSink): void {
    sink = next;
}

/** Whether a line at this level would be recorded, for callers that build costly messages. */
export function isLevelEnabled(level: LogLevel): boolean {
    return LEVELS[level] <= LEVELS[currentLevel];
}

function emit(level: LogLevel, args: unknown[]): void {
    if (!isLevelEnabled(level)) {
        return;
    }
    try {
        sink.write(level, args);
    } catch {
        // A failing sink must not take the process with it, and must not recurse by
        // trying to log its own failure through itself.
        consoleSink.write("error", ["Log sink threw; falling back to the console."]);
        consoleSink.write(level, args);
    }
}

export const logger = {
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args),
};

export default logger;
