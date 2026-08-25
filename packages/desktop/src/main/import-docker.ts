import { app, dialog, type BrowserWindow } from "electron";
import { cp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "@sluice/core";

export interface ImportResult {
    imported: boolean;
    message: string;
}

/**
 * Copy an existing installation's data in, so someone moving off Docker keeps their history.
 *
 * Opt-in and copy-only. Nothing scans for a compose checkout - we cannot know where it
 * lives - and nothing is written back to the source, so a failed import leaves the original
 * exactly as it was and the container can simply be started again.
 *
 * The two installs stay separate afterwards. Sharing one directory would put two miners on
 * one account, which is the thing the whole instance guard exists to prevent.
 */
export async function importFromDockerData(win: BrowserWindow | null): Promise<ImportResult> {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
        title: "Choose the bot's data folder",
        message: "Pick the 'data' folder used by the Docker container.",
        properties: ["openDirectory"],
        buttonLabel: "Import",
    });
    if (picked.canceled || !picked.filePaths[0]) {
        return { imported: false, message: "Import cancelled." };
    }
    const source = picked.filePaths[0];

    const looksRight = await stat(join(source, "auth.json")).then(
        () => true,
        async () =>
            readdir(join(source, "users")).then(
                (entries) => entries.length > 0,
                () => false,
            ),
    );
    if (!looksRight) {
        return {
            imported: false,
            message:
                "That folder does not look like a bot data directory - expected auth.json " +
                "or a users folder inside it.",
        };
    }

    const confirmed = await dialog.showMessageBox(win ?? undefined!, {
        type: "warning",
        buttons: ["Import", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: "Stop the container first",
        message: "Is the Docker container stopped?",
        detail:
            "Both copies mining the same account at once makes Twitch credit neither " +
            "reliably. Nothing is written back to the folder you picked, so you can start " +
            "the container again afterwards - but not at the same time as this app.",
    });
    if (confirmed.response !== 0) {
        return { imported: false, message: "Import cancelled." };
    }

    const target = app.getPath("userData");
    try {
        await cp(join(source, "auth.json"), join(target, "auth.json"), { force: true }).catch(
            () => undefined,
        );
        await cp(join(source, "users"), join(target, "users"), {
            recursive: true,
            force: true,
        }).catch(() => undefined);
        logger.info(`Imported data from ${source}`);
        return {
            imported: true,
            message: "Imported. Restart the app to sign in with the imported account.",
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Import failed: ${message}`);
        return { imported: false, message: `Import failed: ${message}` };
    }
}
