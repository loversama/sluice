import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IconCache } from "../packages/desktop/src/main/icon-cache.js";

/** A real PNG, small but past the "this is an error page" floor. */
const PNG = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.alloc(200, 7),
]);

let server: Server;
let base = "";
let requests = 0;

beforeAll(async () => {
    server = createServer((req, res) => {
        requests += 1;
        if (req.url?.startsWith("/reward.png")) {
            res.writeHead(200, { "content-type": "image/png" });
            res.end(PNG);
        } else if (req.url === "/tiny") {
            // A CDN handing back an error page with a 200, which happens.
            res.writeHead(200).end("no");
        } else {
            res.writeHead(404).end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => server.close());

const cacheIn = async () => new IconCache(await mkdtemp(join(tmpdir(), "sluice-icons-")));

/**
 * Native notifications will not fetch a URL - Windows and Linux both want a local file, and
 * silently show the app icon or nothing when handed anything else. The reward art is the
 * most recognisable part of a claim, so it gets downloaded.
 */
describe("IconCache", () => {
    it("puts the art on disk and hands back the path", async () => {
        const cache = await cacheIn();
        const path = await cache.pathFor(`${base}/reward.png`);

        expect(path).toBeTruthy();
        expect(await readFile(path!)).toEqual(PNG);
    });

    it("fetches a given reward once, however often it is claimed", async () => {
        // Tiers of one campaign share art, and a busy account claims all day.
        const cache = await cacheIn();
        requests = 0;

        const first = await cache.pathFor(`${base}/reward.png?x=1`);
        const second = await cache.pathFor(`${base}/reward.png?x=1`);

        expect(second).toBe(first);
        expect(requests).toBe(1);
    });

    it("keeps different rewards apart", async () => {
        const cache = await cacheIn();
        const a = await cache.pathFor(`${base}/reward.png?a`);
        const b = await cache.pathFor(`${base}/reward.png?b`);

        expect(a).not.toBe(b);
    });

    it("returns null rather than throwing when the art cannot be had", async () => {
        // A notification without its picture beats a claim that goes unannounced.
        const cache = await cacheIn();

        expect(await cache.pathFor(`${base}/missing.png`)).toBeNull();
        expect(await cache.pathFor("http://127.0.0.1:1/nothing.png")).toBeNull();
        expect(await cache.pathFor(null)).toBeNull();
        expect(await cache.pathFor(undefined)).toBeNull();
        expect(await cache.pathFor("")).toBeNull();
    });

    it("refuses a body too small to be an image", async () => {
        const cache = await cacheIn();

        expect(await cache.pathFor(`${base}/tiny`)).toBeNull();
    });

    it("will not follow anything that is not http", async () => {
        const cache = await cacheIn();

        expect(await cache.pathFor("file:///etc/passwd")).toBeNull();
        expect(await cache.pathFor("data:image/png;base64,AAAA")).toBeNull();
    });

    it("writes nothing for a rejected download", async () => {
        const dir = await mkdtemp(join(tmpdir(), "sluice-icons-"));
        await new IconCache(dir).pathFor(`${base}/missing.png`);

        const names = await readdir(dir).catch(() => []);
        expect(names).toEqual([]);
    });
});
