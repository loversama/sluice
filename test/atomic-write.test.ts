import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "../src/atomic-write.js";

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
});
