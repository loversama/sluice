import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { writeFileAtomic } from "./atomic-write.js";
import logger from "./logger.js";

/** Where one account's state lives. `auth.json` is deliberately not here - see below. */
export interface UserPaths {
    dir: string;
    config: string;
    steam: string;
    state: string;
    claims: string;
}

/**
 * The files as they were laid out before accounts had their own directories.
 *
 * These are only ever read, and only to seed the first account that signs in.
 */
export interface LegacyPaths {
    config: string;
    steam: string;
    state: string;
    claims: string;
}

/**
 * Settle on the directory for the signed-in account, seeding it from the older flat layout
 * the first time and only the first time.
 *
 * `auth.json` stays outside this: it is what says *which* account is signed in, so it
 * cannot live inside a directory chosen by reading it.
 *
 * The legacy files are copied rather than moved, so rolling back to an earlier build finds
 * them where it left them, and a marker records which account took them. Without that
 * marker the "do I already have my own copy?" test is per directory and therefore true for
 * every new account - handing the second one the first's drop history, Steam library, and a
 * config.json carrying Steam, SinfulShadows, Telegram and Discord credentials in clear text.
 */
export async function resolveUserPaths(
    dataDir: string,
    legacy: LegacyPaths,
    account: { userId: string; login: string },
): Promise<UserPaths> {
    const dir = join(dataDir, "users", account.userId);
    await mkdir(dir, { recursive: true });

    const owned: UserPaths = {
        dir,
        config: join(dir, "config.json"),
        steam: join(dir, "steam.json"),
        state: join(dir, "state.json"),
        claims: join(dir, "claims.json"),
    };

    const claimMarker = join(dataDir, "users", ".adopted");
    const alreadyClaimed = await readFile(claimMarker, "utf8").then(
        (contents) => contents.trim(),
        () => null,
    );
    const mayAdopt = alreadyClaimed === null || alreadyClaimed === account.userId;
    if (!mayAdopt) {
        logger.debug(
            `Legacy files already belong to user ${alreadyClaimed}; starting ${account.login} clean.`,
        );
        return owned;
    }

    let adoptedAnything = false;
    const adopt = async (from: string, to: string): Promise<void> => {
        const hasOwn = await readFile(to).then(
            () => true,
            () => false,
        );
        if (hasOwn) {
            return;
        }
        const contents = await readFile(from, "utf8").catch(() => null);
        if (contents !== null) {
            await writeFileAtomic(to, contents);
            adoptedAnything = true;
            logger.info(`Adopted ${basename(from)} for ${account.login}.`);
        }
    };
    await adopt(legacy.config, owned.config);
    await adopt(legacy.steam, owned.steam);
    await adopt(legacy.state, owned.state);
    await adopt(legacy.claims, owned.claims);

    // An install that adopted before this marker existed has no claim on record, which
    // would let the next account inherit the flat files after all. Identical content is
    // proof this account is the one that took them, so record it retrospectively.
    const inheritedEarlier = async (): Promise<boolean> => {
        const [before, after] = await Promise.all([
            readFile(legacy.config, "utf8").catch(() => null),
            readFile(owned.config, "utf8").catch(() => null),
        ]);
        return before !== null && before === after;
    };
    if (alreadyClaimed === null && (adoptedAnything || (await inheritedEarlier()))) {
        await writeFileAtomic(claimMarker, `${account.userId}\n`);
        logger.debug(`Legacy files recorded as belonging to ${account.login}.`);
    }

    return owned;
}
