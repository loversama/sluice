import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "../packages/core/src/atomic-write.js";

async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "tdb-atomic-"));
}

describe("writeFileAtomic", () => {
    it("writes a new file", async () => {
        const path = join(await tempDir(), "out.json");
        await writeFileAtomic(path, '{"a":1}');
        expect(await readFile(path, "utf8")).toBe('{"a":1}');
    });

    it("replaces an existing file", async () => {
        const path = join(await tempDir(), "out.json");
        await writeFile(path, "old");
        await writeFileAtomic(path, "new");
        expect(await readFile(path, "utf8")).toBe("new");
    });

    it("creates missing parent directories", async () => {
        const path = join(await tempDir(), "nested", "deep", "out.json");
        await writeFileAtomic(path, "hello");
        expect(await readFile(path, "utf8")).toBe("hello");
    });

    it("leaves no temporary file behind", async () => {
        const dir = await tempDir();
        await writeFileAtomic(join(dir, "out.json"), "hello");
        expect(await readdir(dir)).toEqual(["out.json"]);
    });

    it("keeps the original readable while a new write is in progress", async () => {
        // A reader between the two writes sees one complete file or the other, never a
        // half-written one - which is the property the rename buys.
        const path = join(await tempDir(), "out.json");
        await writeFileAtomic(path, JSON.stringify({ n: 1 }));
        const inFlight = writeFileAtomic(path, JSON.stringify({ n: 2 }));
        const observed = JSON.parse(await readFile(path, "utf8")) as { n: number };
        await inFlight;

        expect([1, 2]).toContain(observed.n);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ n: 2 });
    });

    it("survives overlapping writes to the same file", async () => {
        // State is saved fire-and-forget at every change, so writes overlap routinely.
        const dir = await tempDir();
        const path = join(dir, "out.json");
        const writes = Array.from({ length: 20 }, (_, n) =>
            writeFileAtomic(path, JSON.stringify({ n })),
        );
        await expect(Promise.all(writes)).resolves.toBeDefined();

        const final = JSON.parse(await readFile(path, "utf8")) as { n: number };
        expect(final.n).toBeGreaterThanOrEqual(0);
        expect(final.n).toBeLessThan(20);
        expect(await readdir(dir)).toEqual(["out.json"]);
    });
});
