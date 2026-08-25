import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InstanceLock, instanceLockPath } from "../src/instance-guard.js";

async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "tdb-lock-"));
}

const owner = { userId: "42", login: "tester" };

describe("InstanceLock", () => {
    it("is granted when nobody holds it", async () => {
        const lock = new InstanceLock(instanceLockPath(await tempDir()));
        expect(await lock.acquire(owner)).toBeNull();
        await lock.release();
    });

    it("records who holds it, so a refusal can name them", async () => {
        const dir = await tempDir();
        const lock = new InstanceLock(instanceLockPath(dir));
        await lock.acquire(owner);

        const written = JSON.parse(await readFile(instanceLockPath(dir), "utf8")) as {
            pid: number;
            login: string;
        };
        expect(written.pid).toBe(process.pid);
        expect(written.login).toBe("tester");
        await lock.release();
    });

    it("refuses a second holder while the first is alive", async () => {
        const dir = await tempDir();
        // A live process that is not us: the test runner's parent will do.
        await writeFile(
            instanceLockPath(dir),
            JSON.stringify({
                pid: process.ppid,
                userId: "42",
                login: "someone-else",
                startedAt: Date.now(),
                heartbeatAt: Date.now(),
            }),
        );

        const held = await new InstanceLock(instanceLockPath(dir)).acquire(owner);
        expect(held?.heldBy.login).toBe("someone-else");
    });

    it("takes over from a holder that stopped reporting in", async () => {
        // A hard kill leaves the file behind. Treating that as permanent would lock a user
        // out of their own bot until they went looking for it.
        const dir = await tempDir();
        await writeFile(
            instanceLockPath(dir),
            JSON.stringify({
                pid: process.pid,
                userId: "42",
                login: "ghost",
                startedAt: Date.now() - 600_000,
                heartbeatAt: Date.now() - 600_000,
            }),
        );

        const lock = new InstanceLock(instanceLockPath(dir));
        expect(await lock.acquire(owner)).toBeNull();
        await lock.release();
    });

    it("takes over when the recorded process no longer exists", async () => {
        const dir = await tempDir();
        await writeFile(
            instanceLockPath(dir),
            JSON.stringify({
                pid: 0x7ffffffe, // never a real pid
                userId: "42",
                login: "gone",
                startedAt: Date.now(),
                heartbeatAt: Date.now(),
            }),
        );

        const lock = new InstanceLock(instanceLockPath(dir));
        expect(await lock.acquire(owner)).toBeNull();
        await lock.release();
    });

    it("lets the same process re-acquire across a sign-out", async () => {
        // Signing out and back in must not be blocked by the claim we left ourselves.
        const dir = await tempDir();
        const lock = new InstanceLock(instanceLockPath(dir));
        await lock.acquire(owner);

        const second = new InstanceLock(instanceLockPath(dir));
        expect(await second.acquire(owner)).toBeNull();
        await second.release();
    });

    it("frees the lock on release", async () => {
        const dir = await tempDir();
        const lock = new InstanceLock(instanceLockPath(dir));
        await lock.acquire(owner);
        await lock.release();

        await expect(readFile(instanceLockPath(dir), "utf8")).rejects.toBeDefined();
    });
});
