import { BrowserWindow, screen, shell } from "electron";

/**
 * Native-feeling toasts for the desktop build.
 *
 * Electron's own Notification would be the obvious choice and is not used, for one reason:
 * its icon has to be a local file or a NativeImage, and the thing worth showing here is the
 * reward art, which lives on Twitch's CDN. Downloading every reward to a temp file to show
 * it for six seconds is a lot of machinery for a picture. A small transparent window can
 * point an <img> at the URL and be done.
 *
 * The window only exists while something is on screen. An always-on-top window parked in
 * the corner swallows clicks in that corner even when it has nothing to say.
 */

export interface Toast {
    kind: "claim" | "complete";
    /** The small line above, naming what happened. */
    title: string;
    /** The reward, or the campaign. */
    name: string;
    game?: string | null;
    imageUrl?: string | null;
    /** Opened if the toast is clicked. Defaults to focusing the app. */
    url?: string | null;
}

const WIDTH = 380;
/** Enough for three stacked, which is more than arrive at once in practice. */
const HEIGHT = 330;
const DISMISS_MS = 6500;

export class ToastOverlay {
    private win: BrowserWindow | null = null;
    private queued: Toast[] = [];
    private ready = false;
    private hideTimer: NodeJS.Timeout | undefined;

    constructor(private readonly focusMain: () => void) {}

    show(toast: Toast): void {
        this.queued.push(toast);
        this.ensureWindow();
        if (this.ready) this.flush();
    }

    destroy(): void {
        clearTimeout(this.hideTimer);
        this.win?.destroy();
        this.win = null;
        this.ready = false;
    }

    private ensureWindow(): void {
        if (this.win && !this.win.isDestroyed()) {
            if (!this.win.isVisible()) this.win.showInactive();
            return;
        }

        // The work area, not the display bounds, so it sits above the taskbar.
        const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

        this.win = new BrowserWindow({
            width: WIDTH,
            height: HEIGHT,
            x: x + width - WIDTH - 12,
            y: y + height - HEIGHT - 12,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            // Never steals focus: a claim arriving must not interrupt what is being typed.
            focusable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            hasShadow: false,
            show: false,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });

        this.win.setAlwaysOnTop(true, "screen-saver");
        this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

        // Clicking a toast belongs to the app, not to a browser.
        this.win.webContents.setWindowOpenHandler(({ url }) => {
            if (url === "sluice://focus") this.focusMain();
            else void shell.openExternal(url);
            return { action: "deny" };
        });

        this.win.once("ready-to-show", () => {
            this.ready = true;
            this.win?.showInactive();
            this.flush();
        });

        void this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    }

    private flush(): void {
        const pending = this.queued;
        this.queued = [];
        if (!this.win || this.win.isDestroyed()) return;
        if (!this.win.isVisible()) this.win.showInactive();

        for (const toast of pending) {
            // Pushed in rather than sent over IPC, so the window needs no preload and keeps
            // its sandbox. JSON.stringify is the only escaping involved, and the values are
            // reward names from Twitch rather than anything this process composes.
            void this.win.webContents.executeJavaScript(
                `window.addToast(${JSON.stringify(toast)})`,
                true,
            );
        }

        // Hide once the last one has had its time, so the corner stops swallowing clicks.
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => this.win?.hide(), DISMISS_MS + 600);
    }
}

/**
 * The toast itself.
 *
 * Inlined rather than shipped as a file so it cannot go missing from a package build, and
 * so it needs no preload: it listens for the message Electron delivers to the frame and
 * talks back by opening a URL the main process intercepts.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; overflow: hidden; background: transparent;
    display: flex; flex-direction: column; justify-content: flex-end; height: 100vh; gap: 8px;
    font: 13px/1.4 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .toast {
    display: flex; gap: 12px; align-items: center;
    padding: 12px 14px; margin: 0 4px;
    border-radius: 12px;
    background: rgba(23, 21, 32, 0.96);
    border: 1px solid rgba(255,255,255,0.09);
    border-left: 3px solid var(--accent, #a970ff);
    box-shadow: 0 10px 34px rgba(0,0,0,0.55);
    cursor: pointer;
    animation: in 260ms cubic-bezier(.2,.9,.3,1) both;
  }
  .toast.out { animation: out 260ms ease forwards; }
  .toast.complete { --accent: #3ddc84; }
  @keyframes in  { from { opacity: 0; transform: translateX(24px) scale(.98); } }
  @keyframes out { to   { opacity: 0; transform: translateX(24px); } }
  @media (prefers-reduced-motion: reduce) {
    .toast, .toast.out { animation: none; }
  }
  .art {
    width: 48px; height: 48px; flex: 0 0 auto; border-radius: 8px; object-fit: cover;
    background: rgba(255,255,255,0.06);
  }
  .text { min-width: 0; flex: 1; }
  .kind {
    font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--accent, #a970ff); font-weight: 600;
  }
  .name {
    color: #f2f0f6; font-weight: 600; font-size: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
  }
  .game {
    color: #a9a4b8; font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
</style>
<body>
<script>
  const DISMISS = ${DISMISS_MS};

  window.addToast = function (toast) {
    const el = document.createElement("div");
    el.className = "toast" + (toast.kind === "complete" ? " complete" : "");

    if (toast.imageUrl) {
      const img = document.createElement("img");
      img.className = "art";
      img.src = toast.imageUrl;
      // A CDN that refuses leaves a neat empty tile rather than a broken-image glyph.
      img.onerror = () => img.remove();
      el.appendChild(img);
    }

    const text = document.createElement("div");
    text.className = "text";
    for (const [cls, value] of [["kind", toast.title], ["name", toast.name], ["game", toast.game]]) {
      if (!value) continue;
      const line = document.createElement("div");
      line.className = cls;
      line.textContent = value;
      text.appendChild(line);
    }
    el.appendChild(text);

    // window.open is intercepted by the main process; the page opens nothing itself.
    el.onclick = () => { window.open(toast.url || "sluice://focus"); dismiss(el); };
    document.body.appendChild(el);

    // Only ever three on screen; the oldest goes rather than the stack growing off-screen.
    while (document.body.children.length > 3) document.body.firstElementChild.remove();

    setTimeout(() => dismiss(el), DISMISS);
  };

  function dismiss(el) {
    if (!el.isConnected || el.classList.contains("out")) return;
    el.classList.add("out");
    setTimeout(() => el.remove(), 280);
  }
</script>
</body>`;
