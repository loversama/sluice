# Running the desktop build

**This cannot be developed from WSL.** Electron needs a real display and a Windows Node
install; run these from PowerShell against the same working copy.

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

- The window opens on the device-code screen without waiting for a Twitch login.
- The **twitch.tv/activate** link opens your default browser, not a window inside the app.
- **Settings -> Sign in through Steam** leaves the app, completes in the browser, and the
  Settings page updates over SSE when it returns. This one is the fiddliest: the anchor is
  a same-tab navigation to our own `/api/steam/login`, which then 302s outward, so the
  interception has to catch the redirect leg rather than the click.
- Signing out returns to the device-code screen **without the app exiting**.
- Launching a second copy focuses the first window instead of starting another.
- With the Docker container running, the app refuses to mine and says so - both copies on
  one account is the thing that must not happen.
- `%APPDATA%\Twitch Drops Bot\logs\desktop.log` exists and has content. Without a console
  this is the only place diagnostics go.

## Data

`%APPDATA%\Twitch Drops Bot\` - `auth.json` at the root, then
`users/<twitchUserId>/{config,steam,state,claims}.json`, which the core produces on its own.

Do not point this at the Docker `./data` directory. They are separate installs by design;
importing from one is a later phase, and copies rather than shares.
