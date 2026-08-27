/**
 * When the miner is allowed to run.
 *
 * Twitch credits one watch session per account, so two copies in two places starve each
 * other. Detecting that after the fact is useful; not colliding in the first place is
 * better, and that means each copy knowing which hours are its own.
 */

export interface ScheduleWindow {
    /** Days this window applies to, 0 = Sunday, as JavaScript numbers them. */
    days: number[];
    /** Local wall-clock start, "HH:MM". */
    from: string;
    /** Local wall-clock end, "HH:MM". Earlier than `from` means it runs past midnight. */
    to: string;
}

export interface Schedule {
    enabled: boolean;
    windows: ScheduleWindow[];
}

const MINUTES_PER_DAY = 24 * 60;

/** Minutes past local midnight, or null if the text is not a time. */
export function parseTime(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? "");
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/**
 * Whether mining is allowed right now.
 *
 * Two cases deserve their reasoning written down. A schedule that is switched on but has no
 * windows means nothing has been restricted yet, so everything is allowed - the alternative
 * is an app that silently stops mining the moment the switch is flipped, before the user has
 * had a chance to say when. And a window whose end is earlier than its start runs past
 * midnight, which is the shape most people want for an overnight slot; its days name the day
 * it *begins*, so "Friday 22:00-06:00" covers Saturday's small hours.
 */
export function isWithinSchedule(schedule: Schedule | undefined, now: Date): boolean {
    if (!schedule?.enabled || !schedule.windows?.length) {
        return true;
    }

    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const yesterday = (day + 6) % 7;

    for (const window of schedule.windows) {
        const from = parseTime(window.from);
        const to = parseTime(window.to);
        // An unparseable window is ignored rather than treated as "always" or "never":
        // guessing either way turns a typo into a mining decision.
        if (from === null || to === null || from === to) continue;

        if (from < to) {
            if (window.days.includes(day) && minutes >= from && minutes < to) return true;
            continue;
        }

        // Past midnight: the evening part today, the morning part carried from yesterday.
        if (window.days.includes(day) && minutes >= from) return true;
        if (window.days.includes(yesterday) && minutes < to) return true;
    }

    return false;
}

/** When the current state next changes, so the miner can sleep until then rather than poll. */
export function minutesUntilChange(schedule: Schedule | undefined, now: Date): number {
    if (!schedule?.enabled || !schedule.windows?.length) return MINUTES_PER_DAY;

    const allowed = isWithinSchedule(schedule, now);
    const probe = new Date(now.getTime());

    for (let ahead = 1; ahead <= MINUTES_PER_DAY * 7; ahead += 1) {
        probe.setTime(now.getTime() + ahead * 60_000);
        if (isWithinSchedule(schedule, probe) !== allowed) return ahead;
    }
    return MINUTES_PER_DAY;
}
