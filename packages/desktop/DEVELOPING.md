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
- `logs/desktop.log` in the data directory (below) exists and has content. Without a
  console this is the only place diagnostics go.

### On Linux

Linux packages are built only in CI (`build-desktop.yml`), and the build there starts the
unpacked app under Xvfb to prove it launches. Everything past that is by hand, on a real
desktop, with the AppImage and the deb from the workflow's artifacts:

- The AppImage starts after `chmod +x` (it needs `libfuse2`, `libfuse2t64` on Ubuntu 24.04
  and later), and the deb installs with `sudo apt install ./sluice_*.deb`.
- Both show up in the application menu as Sluice with the purple mark, and the open window
  groups under that entry in the dock rather than as a separate, iconless app.
- The tray icon appears (GNOME needs the AppIndicator extension), a single click opens the
  window, and the menu's Pause/Resume and Quit work.
- Closing the window shows the "Still mining" notification, and opening Sluice again from the
  menu brings the window back.
- **Starts at login** writes `~/.config/autostart/sluice.desktop` with `Exec="<path>"
  --hidden`, pointing at the AppImage file itself (not a `/tmp/.mount_*` path) or at the deb's
  binary, and turning it off removes the file. Log out and in once to see it start hidden.
- Updating the AppImage installs on quit without a password. The deb downloads the update
  but leaves installing to the dashboard's button, which asks for a password.
- Claim notifications arrive as native notifications; on Wayland they do so even when the
  themed style is selected.

## Data

Electron names the data directory after `name` in `package.json`, so it is
`@sluice/desktop`, not "Sluice". That is not something to change casually: renaming it would
leave every existing install looking signed out.

- Windows: `%APPDATA%\@sluice\desktop\`
- Linux: `~/.config/@sluice/desktop/` (or under `$XDG_CONFIG_HOME`)

`auth.json` at the root, then
`users/<twitchUserId>/{config,steam,state,claims}.json`, which the core produces on its own.

Do not point this at the Docker `./data` directory. They are separate installs by design;
importing from one is a later phase, and copies rather than shares.
