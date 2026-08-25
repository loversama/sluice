# PLAN — Windows Desktop Build (Electron)

A second distribution of the Twitch Drops Bot: a double-clickable, unsigned Windows x64
`.exe` wrapping the existing daemon and the existing dashboard. Docker remains the first
distribution; both ship from one repo, sharing one mining core, and **the Docker build must
keep working at the end of every phase**.

Stack (decided): electron-builder (NSIS), electron-vite, electron-updater + GitHub
Releases, `contextIsolation: true` / `nodeIntegration: false`. Renderer loads from
`http://127.0.0.1:<ephemeral port>` — decided, and not revisited here; it is what lets the
`isCrossOrigin` / `isKnownHost` guards in `src/api/server.ts` pass untouched and the
dashboard ship with zero changes. Code signing is out of scope.

---

## Decisions made in this plan (and dissents)

| # | Decision | Call |
|---|----------|------|
| D1 | Daemon child: `utilityProcess` vs in-process vs fork | **In-process in main.** Argued in Phase 4. This is the one question that was open; my recommendation is firm. |
| D2 | Workspace shape | Keep the proposed 4 packages (`core`, `server`, `daemon`, `desktop` + shared `web/`). The `server` split initially looked like ceremony, but it earns its keep: it lets `core` stay free of `node:http` and static-file serving, and both hosts compose `ApiServer` around the same `ServerContext`. |
| D3 | NodeNext migration cost | **Already paid.** `src/` is already `module: NodeNext` with explicit `.js` suffixes on every relative import. The split is file moves + package plumbing, not an import-syntax migration. |
| D4 | `allowStreamEmbed` on desktop | Default **off** via a `configDefaults` override — Electron's persistent cookie jar makes an embedded player a plausible second watch session. Existing configs are never force-changed; the toggle stays in Settings. |
| D5 | Auto-update publish target | **Public GitHub repo** (or a dedicated public `twitch-drops-bot-releases` repo). Do NOT copy Hearth's embedded `GITHUB_UPDATE_TOKEN` — shipping a PAT inside an installer is a credential leak, and updates are load-bearing here (hash rotations). If the source must stay private, publish installers to a public releases-only repo. |
| D6 | NSIS mode | `oneClick: true`, per-user, no elevation. Hearth's `requireAdministrator` + `perMachine` exist for its Windows service; we have none and must not copy them. |
| D7 | Logout restart | In-process session loop **in both distributions**. Docker's `restart: unless-stopped` stays as a backstop, but `process.exit(0)`-as-control-flow goes away everywhere. One code path, and the desktop needs it anyway. |
| D8 | Corrupt `config.json` | Stop being fatal. Rename to `config.json.corrupt-<ts>`, continue on defaults, surface a `problem` event. This is a deliberate behaviour change for Docker too — a truncated file currently bricks the daemon, which was already wrong there. |
| D9 | Dashboard HMR inside Electron | Skip it. Dashboard development keeps happening in a normal browser against `npm run dev:web` exactly as today; Electron always loads the built `web/dist` through the daemon's own server. One less origin permutation, zero guard changes. |
| D10 | Playwright vs Electron | Yes, but **one smoke spec only** (launch, window appears, `/api/state` answers, quit cleanly). It catches exactly the class of bugs unit tests cannot — packaged path resolution, asar layout, port wiring. Full UI flows via Playwright are not worth it; the dashboard is testable in a browser if ever needed. |

---

## Phase 1 — Correctness fixes in the current tree

**Goal:** land every defect that is either an Electron prerequisite or trivially cheap,
before any file moves, so the fixes are reviewable as small diffs and Docker users get them
immediately.

**Why first:** the PubSub resurrection bug becomes reachable the moment logout restarts
in-process (Phase 2), so it must precede it. Atomic writes and config salvage change
behaviour the rest of the plan assumes. Doing this inside the current layout keeps each fix
a focused diff against files the tests already cover.

**Tasks**
1. `src/twitch/websocket.ts` — kill the zombie reconnect:
   - store the reconnect `setTimeout` handle on the connection; `close()` clears it and
     unsubscribes/clears topics;
   - the reconnect path checks `closing` before scheduling;
   - `connect()` stops resetting `closing` unconditionally — only an explicit external
     open may clear it.
2. `src/config.ts`, `src/claims.ts`, `src/state.ts`, steam cache save — atomic writes:
   add `writeFileAtomic(path, data)` (write `path + ".tmp"`, then `rename`; Node's
   `rename` replaces on Windows via `MOVEFILE_REPLACE_EXISTING`, so it is safe on both
   platforms) and route all five persisted files through it, including the
   `AuthState.save()` path.
3. `src/config.ts` — corrupt-config salvage (D8): on parse failure rename the file to
   `config.json.corrupt-<timestamp>`, log a warning, return defaults. Never throw out of
   `loadConfig` for bad JSON.
4. `src/miner.ts` `scheduleCampaignRefresh()` — read `this.config.campaignRefreshMinutes`
   inside the tick instead of capturing `interval` once, and have `applyConfig()` re-arm
   the timer when the value changes.
5. Process-level `unhandledRejection` / `uncaughtException` handlers in `src/index.ts`
   (log + `process.exit(1)`; Docker restarts). Registered in the **entry point**, not the
   core — Electron's main will register its own in Phase 4.
6. Tests: websocket close/reconnect unit test (fake timers), `writeFileAtomic` test,
   corrupt-config test in `test/config.test.ts`, refresh-interval reschedule test.

**Acceptance**
- `npm test` green, including the four new tests.
- Manually: corrupt `config.json`, start daemon → it boots on defaults and a
  `.corrupt-*` file exists.
- `docker compose up -d --build` behaves exactly as before on the happy path.

**Effort:** 1 sitting (~half a day). **Risks:** low; the websocket fix is the only subtle
one — cover it with fake-timer tests rather than reasoning alone.

---

## Phase 2 — The seam: `createApp()` and the in-process session loop

**Goal:** split `main()`'s single linear function into a persistent layer and a re-runnable
session, behind one exported entry point, still inside the current package. Logout returns
to the device-code screen without the process dying — in Docker too (D7).

**Why now:** this is the riskiest pure-logic change in the plan and it needs the real test
suite and real Docker deployment around it, not a half-moved workspace. Everything Electron
does later is composition around this seam.

**Tasks**
1. `src/logger.ts` — injectable sink:
   ```ts
   export interface LogSink {
       write(level: LogLevel, line: string): void;
   }
   export function setLogSink(sink: LogSink): void;   // default: the current console sink
   ```
   The console formatting moves into the default sink; core code keeps calling
   `logger.info(...)` unchanged.
2. `src/api/server.ts` — `listen()` returns the bound port so `port: 0` is usable:
   ```ts
   listen(host: string, port: number): Promise<number> {
       this.boundHost = host.toLowerCase();
       return new Promise((resolvePromise, rejectPromise) => {
           this.server.once("error", rejectPromise);
           this.server.listen(port, host, () => {
               const actual = (this.server.address() as AddressInfo).port;
               logger.info(`Dashboard listening on http://${host}:${actual}`);
               resolvePromise(actual);
           });
       });
   }
   ```
   (The daemon keeps passing 4400; nothing else changes yet.)
3. New `src/app.ts` — the core entry point:
   ```ts
   export interface AppOptions {
       /** Root of all persisted state: auth.json + users/<id>/… live under here. */
       dataDir: string;
       /** Distribution-specific defaults layered over DEFAULT_CONFIG (D4). */
       configDefaults?: Partial<Config>;
       logLevel?: LogLevel;
       logSink?: LogSink;
       dryRun?: boolean;
       /** Fired whenever a device-code login begins (first run and after logout). */
       onDeviceCode?(info: DeviceCodeInfo): void;
       /** Fired after credentials are revoked, as the next login round starts. */
       onLogout?(): void;
       /** Fatal/warning conditions the host may surface natively (tray balloon, dialog). */
       onProblem?(p: { level: "warn" | "fatal"; code: string; message: string }): void;
   }

   export interface AppHandle {
       /** The bus the dashboard's SSE stream is fed from. Host may also emit into it. */
       readonly bus: EventEmitter;
       /** Passed to ApiServer by the host; core knows nothing about HTTP. */
       readonly context: ServerContext;
       /** Kick off the login→mine session loop. Returns at once; work is background. */
       start(): void;
       /** Bounded shutdown: signal the miner, flush files, resolve within ~3s. */
       stop(): Promise<void>;
       /** Flush pending state/claims writes now (used by Electron will-quit). */
       flush(): Promise<void>;
   }

   export function createApp(options: AppOptions): AppHandle;
   ```
   The **persistent layer** created once inside `createApp`: `AuthState`, the `bus`,
   `ServerContext`, `SteamLibrary`, paths. The **per-session** part is a new
   `runSession()` extracted from the back half of today's `main()`:
   - resolves auth (load/validate or device-code authorize on the **reused** `AuthState`
     — its `clear()` deliberately preserves the pinned deviceId and Android UA; never
     rebuild it),
   - runs the per-user directory adoption block (moves to `src/paths.ts`),
   - re-reads config/steam/state/claims for that user,
   - builds a **fresh** `Miner` (its `stopping` latch never resets) and a fresh
     `NotifierGroup`, wires all miner events (all notification copy included) to the bus,
   - awaits `miner.start()`, returning an outcome: `"logout" | "stopped" | "stale-hash"
     | "crashed"`.
   The loop around it:
   ```ts
   while (!stopped) {
       const outcome = await runSession(deps);
       if (outcome === "logout")     { options.onLogout?.(); continue; }  // back to device code
       if (outcome === "stale-hash") { return; }   // parked: server + dashboard stay up
       if (outcome === "stopped")    { return; }
       await backoff();  // "crashed": 30s doubling to 10min, emit "problem" each time
   }
   ```
   `ServerContext.logout` changes from `process.exit(0)` to: revoke → `rm auth.json` →
   `oldMiner.stop()` **not awaited** (it can be parked in a sleep for up to 20 min) →
   resolve the session's logout signal. The old miner's PubSub cannot resurrect thanks to
   Phase 1. The `ApiServer`, SSE clients, and bus all survive the transition, which is
   exactly why they live in the persistent layer.
4. `src/index.ts` shrinks to CLI parsing + `createApp` + `new ApiServer(handle.context, …)`
   + signal handlers. The stale-hash "stay up and show the banner" behaviour is preserved
   by the loop's `"stale-hash"` park.
5. Tests: a session-loop state-machine test with injected fakes (fake auth, fake miner
   factory) covering logout→new-session, crash→backoff, stale-hash→park; assert the same
   `AuthState` instance crosses sessions and a new `Miner` is built each time.

**Acceptance**
- Dashboard logout → device-code screen reappears **in the same SSE-connected tab, same
  process, same PID** (verify in Docker: `docker compose exec` shows the PID unchanged).
- `--dry-run`, `--logout`, stale-hash park all behave as before.
- Full test suite green.

**Effort:** 1–2 sittings. **Risks:** highest-subtlety phase — the miner-event rewiring
must be torn down per session (`bus` relays persist, but the *miner→bus* listeners belong
to the session; remove them on session end or a dead miner's stray events leak into the
stream). The state-machine test is the mitigation.

---

## Phase 3 — Workspace split

**Goal:** the four-package layout, with Docker and all scripts moved over. Purely
mechanical: no behaviour change.

**Why now:** after the seam exists (so the split follows real boundaries) and before any
Electron code (so `packages/desktop` is born into the right shape rather than migrated).

**Layout and what moves**

```
packages/
  core/         # @tdb/core — no node:http, no CLI
    src/app.ts  session.ts  paths.ts  config.ts  logger.ts  miner.ts
        claims.ts  state.ts  version.ts
        models/  twitch/  notifiers/  steam/
        api/context.ts      # ServerContext + DeviceCodeInfo types (moved out of server.ts)
        api/serialize.ts    # used by both core (event wiring) and server
  server/       # @tdb/server — ApiServer, guards, static serving, SSE
    src/server.ts           # imports ServerContext from @tdb/core
  daemon/       # @tdb/daemon — CLI entry: parseArgs, console sink, fixed port 4400,
    src/index.ts            # signal handlers, Docker paths (./data)
  desktop/      # @tdb/desktop — empty shell this phase (package.json + tsconfig only)
web/            # unchanged, shared; its dist/ is the single dashboard artifact
test/           # split per package (vitest workspace) — server-guards tests move to
                # packages/server, the rest to packages/core
```

**Migration cost, honestly (D3):** the repo already uses NodeNext + explicit `.js`
extensions throughout, so intra-package imports survive the move untouched. The real work
is plumbing: root `package.json` `workspaces`, per-package `package.json` with `exports`
maps, per-package `tsconfig.json` (composite project references, or a plain topological
`npm run build --workspaces` — recommend project references so `tsc -b` handles ordering),
a `vitest.workspace.ts`, and updating the `Dockerfile` (build all workspaces; entry becomes
`packages/daemon/dist/index.js`; `web/dist` copied as before). Budget half the phase for
plumbing, not for code.

**Tasks**
1. Root workspaces + `@tdb/*` package manifests with `exports`; `tsc -b` project refs.
2. `git mv` per the table; fix the handful of cross-package imports to package names.
3. `staticDir` stops being computed from `import.meta.url` inside the daemon guessing at
   `../web/dist` — it becomes an explicit `ApiServer` argument in both hosts (daemon:
   `<repo>/web/dist` resolved from its own location as today; desktop later:
   `process.resourcesPath/web`).
4. Dockerfile + compose + npm scripts (`build`, `build:all`, `start:web`, `check-hashes`)
   updated; `check-hashes` tool lands in `packages/core` with a bin script.
5. CI (if any) and README build instructions updated.

**Acceptance**
- `npm test` green across the workspace; `npm run build:all` produces a runnable daemon.
- `docker compose up -d --build` from scratch: login, mine, dashboard — unchanged.
- `git log --follow` still tracks moved files (use `git mv`).

**Effort:** 1–2 sittings. **Risks:** dependency-direction mistakes (server importing miner
internals rather than `ServerContext`) — enforce by giving `@tdb/core` an `exports` map
that only exposes `app`, `context`, `serialize`, `config`, `logger` types, not deep paths.

---

## Phase 4 — Electron shell MVP

**Goal:** `npm run dev` in `packages/desktop` opens a window showing the real dashboard;
device-code login works with the link opening in the user's real browser; mining runs.
Not yet: tray, packaging, updates.

### The daemon-child decision (D1): run the core **in-process in main**

The question was `utilityProcess` vs in-process vs `child_process.fork`. Recommendation:
**in-process**, and I'd defend it as not even close:

- **Our "daemon" is a library.** After Phase 2 it is literally `createApp()` — an event
  emitter, some timers, a few HTTPS requests a minute, and idle websockets. There is no
  CPU-bound work to keep off the main thread; the renderer (the actual UI) is a separate
  OS process regardless, so UI jank is not on the table.
- **Hearth's supervisor exists because its sidecar is a Rust binary** — a foreign process
  that *must* be spawned, health-checked, and restarted. Copying that shape for a
  same-language library imports ~400 lines of supervisor, an IPC protocol, restart
  bookkeeping, and a whole class of "child died / port unknown / half-initialized" states
  that simply cannot exist in-process.
- **Crash isolation is a mirage here.** If the miner throws, the desired outcome is the
  Phase 2 backoff loop plus a visible problem event — identical in-process. A dead
  utilityProcess needs new code to detect, restart, re-read the new port, and reload the
  window; that code is the supervisor we were trying to avoid writing.
- **In-process buys real integration for free:** main can emit straight onto
  `handle.bus` (e.g. an "update downloaded, restart to apply" toast reaches the dashboard
  over the existing SSE stream with zero new plumbing), `onDeviceCode` can raise the
  window synchronously, and quit is `handle.flush()` + exit.
- The one future that favours a child — "keep mining while the app relaunches for an
  update", or a headless Windows-service mode — is not on the roadmap. The `createApp`
  boundary is precisely the seam that would make a later move to `utilityProcess` a
  contained change, so we lose nothing by deferring it.

`fork` is strictly worse than `utilityProcess` in Electron and is not considered further.

### Tasks

1. `packages/desktop` scaffold: electron-vite with **main + preload targets only** — there
   is no renderer target, because the renderer is `web/dist` served by our own HTTP
   server (that is the point of the loopback-origin decision). Borrow Hearth's
   `externalizeDepsPlugin` usage; drop its renderer block, aliases, and the
   `__GITHUB_UPDATE_TOKEN__` define (D5).
2. Main process (`src/main/index.ts`), the whole thing is ~120 lines:
   ```ts
   import { app, BrowserWindow, shell, dialog } from "electron";
   import { join } from "node:path";
   import { createApp, type AppHandle } from "@tdb/core";
   import { ApiServer } from "@tdb/server";
   import { createFileSink } from "./log-file-sink";

   // port:0 removed the EADDRINUSE crash that used to be the only duplicate-instance
   // guard, so the lock and the ephemeral port MUST ship together.
   if (!app.requestSingleInstanceLock()) {
       app.quit();
   } else {
       let win: BrowserWindow | null = null;
       let handle: AppHandle;
       let port: number;

       app.on("second-instance", () => {
           if (win) { win.show(); win.focus(); }
       });

       const createWindow = () => {
           win = new BrowserWindow({
               width: 1180, height: 800,
               show: false,
               webPreferences: {
                   preload: join(__dirname, "../preload/index.js"),
                   contextIsolation: true,
                   nodeIntegration: false,
                   sandbox: true,
               },
           });
           // The dashboard is the same-origin web app; anything else leaves the app.
           win.webContents.setWindowOpenHandler(({ url }) => {
               void shell.openExternal(url);
               return { action: "deny" };
           });
           const isOurs = (url: string) => new URL(url).host === `127.0.0.1:${port}`;
           win.webContents.on("will-navigate", (event, url) => {
               if (!isOurs(url)) { event.preventDefault(); void shell.openExternal(url); }
           });
           // The Steam OpenID anchor navigates same-tab: /api/steam/login 302s to
           // steamcommunity.com. Catch the redirect leg too, and hand it to the real
           // browser — the OpenID return_to points back at 127.0.0.1:<port>, which the
           // external browser can reach, so the flow completes there.
           win.webContents.on("will-redirect", (event, url) => {
               if (!isOurs(url)) { event.preventDefault(); void shell.openExternal(url); }
           });
           win.once("ready-to-show", () => win!.show());
           void win.loadURL(`http://127.0.0.1:${port}/`);
       };

       app.whenReady().then(async () => {
           const dataDir = app.getPath("userData");        // %APPDATA%\Twitch Drops Bot
           handle = createApp({
               dataDir,
               configDefaults: { allowStreamEmbed: false },  // D4
               logSink: createFileSink(join(dataDir, "logs")),
               onDeviceCode: () => { win?.show(); win?.focus(); },
               onProblem: (p) => { /* Phase 5: tray balloon for level === "fatal" */ },
           });
           const server = new ApiServer(handle.context, resolveWebDist());
           port = await server.listen("127.0.0.1", 0);      // ephemeral; guards pass as-is
           handle.start();                                   // login proceeds in background
           createWindow();   // window is NOT gated on Twitch login — the server is up and
                             // the dashboard's own device-code screen does the waiting
       });

       app.on("window-all-closed", () => app.quit());        // tray changes this in Phase 5
       app.on("will-quit", (event) => {
           event.preventDefault();
           void handle.stop().finally(() => app.exit(0));    // bounded ~3s; never awaits
       });                                                   // a parked miner sleep
   }
   ```
   Plus `resolveWebDist()` in the spirit of Hearth's `resolve-sidecar-path.ts`: env
   override → dev (`../../web/dist` from `__dirname`) → packaged
   (`join(process.resourcesPath, "web")`).
3. `log-file-sink.ts`: append to `logs/desktop.log`, strip ANSI, rotate at 5 MB to
   `desktop.log.old`. Console sink stays attached in dev.
4. Main-process `unhandledRejection`/`uncaughtException`: log to the file sink, show one
   `dialog.showErrorBox` for uncaught exceptions, then quit — never die silently.
5. Preload: **empty this phase.** The dashboard is an unmodified web app speaking
   same-origin HTTP + SSE; it needs nothing from Node to reach feature parity. Ship
   `preload/index.ts` as a stub so the wiring exists.
6. Data layout: `auth.json` at `userData` root; the existing
   `dataDir = dirname(authPath)` + per-user adoption logic then produces
   `users/<twitchUserId>/{config,steam,state,claims}.json` under `userData` with no new
   code. Never point this at a Docker `./data` directory (import is Phase 5, copy-based).
7. Smoke checks in dev on Windows (WSL cannot run this — dev on the Windows side).

**Acceptance**
- `npm run dev` (desktop): window opens on the device-code screen; clicking the
  twitch.tv/activate link opens the **default browser**, not the app window; after
  authorizing, mining starts and the dashboard live-updates over SSE.
- Logout from the dashboard returns to the device-code screen without the app exiting.
- Launching a second copy focuses the first window.
- Steam "Sign in through Steam" completes in the external browser and the Settings page
  reflects the connection.
- `docker compose up` still green (nothing in this phase touches shared code except
  `resolveWebDist` being desktop-local).

**Effort:** 1–2 sittings. **Risks:** the will-redirect interception ordering around the
OpenID 302 is the fiddliest bit — verify with the real Steam flow, and fall back to
navigating the app window if interception proves unreliable (acceptable, just uglier).

---

## Phase 5 — Windows citizenship

**Goal:** the app behaves like a resident background utility: tray, close-to-tray, run at
login, native problem surfacing, duplicate-instance sanity, optional Docker import.

**Why now:** all of it composes on a working shell; none of it blocks packaging, but
shipping an installer without a tray for an app whose whole job is running in the
background would be a bad first impression.

**Tasks**
1. Tray (`resources/icon.ico` + 16/32px assets — a small design task): tooltip shows
   current state fed from `handle.bus` ("Mining <game> — 43/120 min" / "Waiting for
   login"), context menu: Open Dashboard / Pause–Resume (calls `context.getMiner()`
   directly — in-process pays off) / Quit.
2. Close-to-tray: window `close` hides instead of quitting (setting-gated, default on);
   `window-all-closed` no longer quits; Quit lives in the tray. Balloon on first
   hide-to-tray so users know it is still running.
3. Run at login: `app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`;
   `--hidden` starts to tray.
4. First (and only planned) preload surface — desktop-only settings need IPC:
   ```ts
   // preload/index.ts
   contextBridge.exposeInMainWorld("desktopBridge", {
       version: (): Promise<string> => ipcRenderer.invoke("desktop:version"),
       getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke("desktop:get-settings"),
       setSettings: (s: Partial<DesktopSettings>) => ipcRenderer.invoke("desktop:set-settings", s),
       openLogsFolder: () => ipcRenderer.invoke("desktop:open-logs"),
   });
   ```
   `DesktopSettings = { runAtLogin: boolean; closeToTray: boolean }`, persisted by main in
   `userData/desktop.json`. That is the whole bridge; everything else the dashboard does
   stays HTTP.
5. `web/`: a "Desktop" card on the Settings page rendered only when
   `window.desktopBridge` exists — the sole dashboard change in the entire plan, invisible
   to Docker users by construction.
6. Duplicate-mining tripwire: on startup, GET `http://127.0.0.1:4400/api/state` with a
   short timeout; if it answers with our shape, show a one-time warning dialog ("another
   instance — probably the Docker build — is mining on this machine; running both on one
   account corrupts progress"). Detection only, never blocking.
7. Docker import (opt-in, Settings button, not a first-run scan — we cannot know where the
   compose checkout lives): folder picker → validate it looks like a data dir
   (`auth.json`/`users/`) → require the container be stopped (say so in the dialog) →
   copy `auth.json` + `users/**` into `userData` → trigger the session loop to
   re-authenticate. Small, self-contained, cuttable if the phase runs long.
8. Route `onProblem({level:"fatal"})` to a tray balloon (stale-hash being the important
   case: "Mining paused — update required", which sets up Phase 6's story).

**Acceptance**
- Close button hides to tray; miner keeps mining (watch the log); tray Quit exits cleanly
  with state files flushed.
- Reboot (or `--hidden` launch): app starts in tray, resumes mining without a window.
- Settings toggles for run-at-login/close-to-tray persist; Docker build shows no Desktop
  card.
- With the Docker container running, desktop launch shows the duplicate warning.

**Effort:** 1–2 sittings (import + tripwire are the flexible tail). **Risks:** tray icon
lifecycle papercuts (GC'd Tray objects, double balloons) — hold the Tray in a module-level
ref and keep tray code in one file.

---

## Phase 6 — Packaging and auto-update

**Goal:** an NSIS installer a non-technical user can double-click, and updates that arrive
on their own. Auto-update is **load-bearing**: the 12 persisted GraphQL hashes rotate
without warning, Docker users `git pull`, desktop users cannot.

**Tasks**
1. `packages/desktop/electron-builder.yml` — Hearth-derived, with its service/elevation
   machinery removed (D6):
   ```yaml
   appId: com.sinfulshadows.twitch-drops-bot
   productName: Twitch Drops Bot
   directories:
     buildResources: resources
     output: release
   files:
     - "out/**/*"
   extraResources:
     - from: "../../web/dist"      # the one dashboard artifact, same files Docker serves
       to: "web"
   icon: resources/icon.png
   win:
     icon: resources/icon.ico
     target:
       - target: nsis
         arch: [x64]
     # no requestedExecutionLevel — per-user install, no elevation (unlike Hearth)
   nsis:
     oneClick: true                # non-technical audience; no directory picker
     perMachine: false
     createDesktopShortcut: always
     createStartMenuShortcut: true
     shortcutName: Twitch Drops Bot
   publish:
     provider: github
     owner: loversama
     repo: twitch-drops-bot        # MUST be public, or a public releases-only repo (D5)
   ```
2. "Built once, consumed by both" for `web/`: the root `build:all` builds `web/dist`
   exactly once; the Dockerfile copies it (as today) and electron-builder's
   `extraResources` packs the same directory into `resources/web`, which
   `resolveWebDist()` already targets. No second Vite config, no divergence possible.
3. electron-updater in main: `autoUpdater.checkForUpdatesAndNotify()` on ready + every
   6 h; on `update-downloaded`, emit onto `handle.bus` as a `problem`-style
   `{ level: "warn", code: "update-ready", message: … }` so the dashboard shows a toast
   over SSE (in-process dividend), plus a tray balloon; install on quit. When a
   stale-hash park is active, escalate the tray message to "Update required".
4. Version wiring: one version — root package version stamped into `packages/core`'s
   `version.ts` at build (the daemon and the About/Settings display already read it).
5. GitHub Actions: `release.yml` on tag → `windows-latest` → `npm ci`, `build:all`,
   `electron-builder --publish always`. (Docker image build stays whatever it is today.)
6. Unsigned-binary reality check: document the SmartScreen "More info → Run anyway" step
   with a screenshot in the README. **electron-updater applies unsigned updates fine on
   Windows** (no signature-match check like macOS); no work needed, just verify it once.
7. Manual pass on a clean Windows VM: install → login → mine → quit → relaunch (state
   intact) → publish a `v+1` → update arrives, installs on quit, relaunches into the
   same logged-in state.

**Acceptance**
- Clean-VM checklist above, in full, including the real auto-update round trip — this is
  the phase where "works on my machine" dies, so the VM pass is the acceptance test.
- `docker compose up -d --build` still green from the same tag.

**Effort:** 1 sitting of config + 1 sitting of VM verification. **Risks:** D5 is the only
open external dependency (public releases repo needs creating/deciding); NSIS per-user +
oneClick is the well-trodden path so packaging risk is otherwise low.

---

## Phase 7 — Hygiene backlog (long-running-process fixes)

**Goal:** the remaining known defects — none block shipping, all matter for a process that
runs for months, which both distributions now are.

**Tasks**
1. `channelCooldowns` — prune expired entries on each `runOnce()` pass (it is a
   `Map<string, expiryTs>`; drop anything past expiry).
2. `claimHistory.claims` — cap in memory (keep the most recent ~500; full history stays
   on disk append-style), and stop re-scanning the whole array on every `/api/state`
   (precompute the stats summary incrementally on claim).
3. `refreshCampaigns()` — cancellation checkpoints between per-campaign detail fetches
   (`if (this.stopping) return;` each iteration — one exists near line 1637, cover the
   full walk) and a cap on campaigns fetched per refresh, so stop/logout never trails
   minutes of doomed sequential GraphQL work and the abandoned session stops burning
   requests.
4. Re-check memory after 48 h soak on the desktop build (tray tooltip keeps it observable).

**Acceptance:** unit tests for pruning/cap; a soak run shows flat memory; logout during a
refresh completes the session switch in <2 s (the old refresh dies quietly).

**Effort:** 1 sitting. **Risks:** low; isolated changes with existing test coverage
around the miner.

---

## Phase 8 — Test posture and CI

**Goal:** lock in what each layer needs and no more.

**Unit tests (vitest, per package)** — the additions across phases, consolidated:
- core: session loop state machine (Phase 2), websocket lifecycle, atomic writes,
  config salvage, refresh-interval reschedule, cooldown pruning, claim-stats cap.
- server: existing guard tests unchanged (they are the contract that made the loopback
  decision free — treat any needed edit to `server-guards.test.ts` as a red flag), plus
  a `listen(0)` returns-real-port test.
- desktop main: `resolveWebDist` and the will-navigate/will-redirect URL predicate as
  pure functions (extract them to be testable without Electron).

**Playwright vs Electron (D10):** one smoke spec via Playwright's `_electron.launch()`
against the built (unpacked) app: window appears, title correct, fetch
`http://127.0.0.1:<port>/api/state` (port read from a `--print-port` dev flag or the log
line) returns the snapshot shape, app quits within the bounded stop. Run on
`windows-latest` in CI on PRs touching `packages/desktop`. Do **not** build out UI flows
in it — Hearth needs Playwright because its renderer is IPC-coupled to Electron; ours is
a plain web app whose UI can be tested in a browser if that day comes.

**CI:** `test.yml` (ubuntu: workspace tests + Docker image build as the
"never break Docker" gate on every PR) and the Phase 6 `release.yml`.

**Effort:** 1 sitting. **Risks:** Electron-on-CI flakiness — keep the smoke spec to one
retry and non-blocking for the first weeks if it misbehaves.

---

## Sequencing summary

| Phase | Deliverable | Effort |
|---|---|---|
| 1 | Defect fixes in place; Docker users benefit immediately | 1 sitting |
| 2 | `createApp()` + in-process logout restart (both distros) | 1–2 sittings |
| 3 | 4-package workspace; Docker migrated, zero behaviour change | 1–2 sittings |
| 4 | Runnable Electron dev app: login, mine, dashboard, external links | 1–2 sittings |
| 5 | Tray, run-at-login, desktop settings bridge, Docker import | 1–2 sittings |
| 6 | NSIS installer + working auto-update, VM-verified | 2 sittings |
| 7 | Long-run hygiene (cooldowns, claims, refresh cancellation) | 1 sitting |
| 8 | Test consolidation + CI gates | 1 sitting |

~9–13 sittings total. Something runnable exists at the end of Phase 4; shippable at the
end of Phase 6; Phases 7–8 can trail a first release. Every phase ends with the Docker
build green, and Phases 1–2 improve it outright.
