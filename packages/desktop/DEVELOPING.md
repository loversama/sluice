# Running the desktop build

Most of this **can** be run from WSL. WSLg provides a display, and `xvfb-run` works where
it does not:

```bash
npm run build:web && npm run build
npm --prefix packages/desktop run build
xvfb-run -a --server-args="-screen 0 1280x900x24" \
  ./node_modules/electron/dist/electron --no-sandbox packages/desktop/out/main/index.js
```

That is enough to confirm the app starts, binds a free port, serves the dashboard, loads it
in the renderer, and reaches Twitch for a device code. A quick way to prove the renderer
really loaded it, rather than the window merely opening:

```bash
ss -tnp | grep :<port>     # an ESTAB from the renderer process is the SSE stream
```

For anything involving the desktop session itself, use PowerShell against the same working
copy. There is a script at the repository root that does the whole sequence:

```powershell
.\run-desktop.ps1            # install, build, launch
.\run-desktop.ps1 -SkipInstall -SkipWeb   # quicker, once nothing has changed
```

It offers to stop the Docker container first, because the two refuse to mine the same
account at once and the app would otherwise look broken rather than careful. Or do it by
hand:

```powershell
npm install                    # from the repo root, once
npm run build:web              # the dashboard, shared with the Docker build
npm run build                  # the workspace packages
npm --prefix packages/desktop run dev
```

`dev` starts Electron with the main process rebuilt on change. There is no renderer target
and no HMR for the dashboard: it is served from `web/dist` by our own HTTP server, exactly
as the container serves it. Working on the dashboard itself is unchanged - `npm run dev:web`
and a browser, which is a faster loop than any Electron reload would be.

## What to check by hand

The window is the easy part; these are the bits that only fail in a packaged, real-display
context:

- The **twitch.tv/activate** link opens your default browser, not a window inside the app.
  This is the main thing Xvfb cannot answer: there is no browser registered there for
  `shell.openExternal` to reach.
- **Settings -> Sign in through Steam** leaves the app, completes in the browser, and the
  Settings page updates over SSE when it returns. This one is the fiddliest: the anchor is
  a same-tab navigation to our own `/api/steam/login`, which then 302s outward, so the
  interception has to catch the redirect leg rather than the click.
- Signing out returns to the device-code screen **without the app exiting**.
- Launching a second copy focuses the first window instead of starting another.
- With the Docker container running, the app refuses to mine and says so - both copies on
  one account is the thing that must not happen.
- `%APPDATA%\Sluice\logs\desktop.log` exists and has content. Without a console
  this is the only place diagnostics go.

## Data

`%APPDATA%\Sluice\` - `auth.json` at the root, then
`users/<twitchUserId>/{config,steam,state,claims}.json`, which the core produces on its own.

Do not point this at the Docker `./data` directory. They are separate installs by design;
importing from one is a later phase, and copies rather than shares.
