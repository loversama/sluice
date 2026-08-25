# @tdb/desktop

The Windows build: the same mining core and the same dashboard as the Docker image, wrapped
so that running it is a double-click rather than a compose file.

Nothing here yet but the manifest. What lands in this directory is the *host* - a window, a
tray icon, an installer - and nothing else. Anything that decides how mining works belongs
in `@tdb/core`, or the two distributions will disagree the first time either is edited.

Two decisions already made, recorded here because they are easy to undo by accident:

- **The renderer is served over `http://127.0.0.1:<port>`, not `file://` and not a custom
  protocol.** The dashboard talks to the daemon over HTTP and SSE, and the server refuses
  cross-origin writes by comparing `Origin` against `Host`. Loopback HTTP is the only
  arrangement where the renderer is genuinely same-origin, so those guards pass untouched
  and the dashboard needs no desktop-specific build. `file://` sends `Origin: null` and
  every write would be refused.
- **The core runs in the Electron main process**, not a `utilityProcess` or a forked child.
  It is a library, not a foreign binary: there is no CPU-bound work to move off the main
  thread, and supervising a child would mean writing the crash-detection and port-rediscovery
  code that running in-process makes unnecessary. `createApp()` is the seam that would make
  moving to a child process later a contained change.
