import { describe, expect, it } from "vitest";

import { isWithinSchedule, minutesUntilChange, parseTime } from "../packages/core/src/schedule.js";

/** Local time, so the tests read the way a user would set the schedule. */
const at = (day: number, hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    // 2026-08-30 is a Sunday, so adding `day` lands on the day wanted.
    return new Date(2026, 7, 30 + day, h!, m!);
};

const MON = 1, FRI = 5, SAT = 6, SUN = 0;

describe("isWithinSchedule", () => {
    const weekdayEvenings = {
        enabled: true,
        windows: [{ days: [MON, 2, 3, 4, FRI], from: "18:00", to: "23:00" }],
    };

    it("allows mining inside a window", () => {
        expect(isWithinSchedule(weekdayEvenings, at(MON, "20:00"))).toBe(true);
    });

    it("refuses outside it", () => {
        expect(isWithinSchedule(weekdayEvenings, at(MON, "09:00"))).toBe(false);
    });

    it("refuses on a day the window does not name", () => {
        expect(isWithinSchedule(weekdayEvenings, at(SAT, "20:00"))).toBe(false);
    });

    it("includes the start minute and excludes the end", () => {
        // So two windows can meet at 23:00 without both claiming that minute.
        expect(isWithinSchedule(weekdayEvenings, at(MON, "18:00"))).toBe(true);
        expect(isWithinSchedule(weekdayEvenings, at(MON, "23:00"))).toBe(false);
    });

    describe("a window that runs past midnight", () => {
        const overnight = { enabled: true, windows: [{ days: [FRI], from: "22:00", to: "06:00" }] };

        it("covers the evening it starts", () => {
            expect(isWithinSchedule(overnight, at(FRI, "23:30"))).toBe(true);
        });

        it("covers the small hours of the next day", () => {
            // Its days name the day it begins, so Friday's window owns Saturday's morning.
            expect(isWithinSchedule(overnight, at(SAT, "02:00"))).toBe(true);
        });

        it("stops at the end time", () => {
            expect(isWithinSchedule(overnight, at(SAT, "06:00"))).toBe(false);
        });

        it("does not leak into the following evening", () => {
            expect(isWithinSchedule(overnight, at(SAT, "23:30"))).toBe(false);
        });
    });

    it("allows everything when switched off", () => {
        const off = { enabled: false, windows: [{ days: [MON], from: "18:00", to: "19:00" }] };
        expect(isWithinSchedule(off, at(SAT, "04:00"))).toBe(true);
    });

    it("allows everything when switched on with nothing set", () => {
        // Otherwise flipping the switch silently stops the bot before the user has had a
        // chance to say when it should run.
        expect(isWithinSchedule({ enabled: true, windows: [] }, at(SUN, "12:00"))).toBe(true);
    });

    it("ignores a window it cannot read rather than guessing", () => {
        const broken = { enabled: true, windows: [{ days: [SUN], from: "25:00", to: "banana" }] };
        expect(isWithinSchedule(broken, at(SUN, "12:00"))).toBe(false);
    });

    it("takes any window that matches, not just the first", () => {
        const two = {
            enabled: true,
            windows: [
                { days: [MON], from: "08:00", to: "09:00" },
                { days: [MON], from: "20:00", to: "21:00" },
            ],
        };
        expect(isWithinSchedule(two, at(MON, "20:30"))).toBe(true);
    });
});

describe("parseTime", () => {
    it("reads a wall-clock time", () => {
        expect(parseTime("07:30")).toBe(450);
        expect(parseTime("00:00")).toBe(0);
    });

    it("rejects what is not one", () => {
        for (const bad of ["24:00", "12:60", "", "7pm", "0730"]) {
            expect(parseTime(bad)).toBeNull();
        }
    });
});

describe("minutesUntilChange", () => {
    it("counts to the start of the next window", () => {
        const evenings = { enabled: true, windows: [{ days: [MON], from: "18:00", to: "23:00" }] };
        expect(minutesUntilChange(evenings, at(MON, "17:30"))).toBe(30);
    });

    it("counts to the end of the one it is in", () => {
        const evenings = { enabled: true, windows: [{ days: [MON], from: "18:00", to: "23:00" }] };
        expect(minutesUntilChange(evenings, at(MON, "22:45"))).toBe(15);
    });
});
