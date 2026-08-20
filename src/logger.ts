const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

export type LogLevel = keyof typeof LEVELS;

const COLORS: Record<LogLevel, string> = {
    error: "\x1b[31m",
    warn: "\x1b[33m",
    info: "\x1b[36m",
    debug: "\x1b[90m",
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

function emit(level: LogLevel, args: unknown[]): void {
    if (LEVELS[level] > LEVELS[currentLevel]) {
        return;
    }
    const time = new Date().toISOString().slice(11, 19);
    const prefix = `\x1b[90m[${time}]\x1b[0m ${COLORS[level]}${level.padEnd(5)}\x1b[0m`;
    const stream = level === "error" || level === "warn" ? console.error : console.log;
    stream(prefix, ...args);
}

export const logger = {
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args),
};

export default logger;
