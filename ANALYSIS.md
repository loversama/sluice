# Reference analysis

Notes from studying the two existing bots before writing this one. Both are cloned under
`reference/` (git-ignored).

## TychoTheTaco/Twitch-Drops-Bot (Node + Puppeteer)

The bot this project was originally going to be a copy of. **Last commit April 2023.**

### How it worked

It drove a real Chrome through Puppeteer, actually loading `twitch.tv/<channel>` and playing
the video, while a parallel GraphQL client did the bookkeeping.

| Piece | Role |
| --- | --- |
| `twitch.ts` | GQL client using persisted-query SHA256 hashes |
| `twitch_drops_bot.ts` | Campaign priority queue, watchdog, watch loop |
| `web_socket_listener.ts` | Attached a CDP session and sniffed the page's own PubSub frames |
| `pages/stream.ts` | DOM scraping for viewer count, uptime, stream quality |
| `pages/login.ts` | Typed username/password into the login form, scraped 2FA prompts |

### Ideas worth keeping

These were genuinely good and are carried over into this project:

- **Campaign priority ordering** — config game order, then soonest-ending, then preferred
  broadcaster. Reimplemented in `compareCampaigns()`.
- **Verify before watching** — call `DropsHighlightService_AvailableDrops` to confirm a
  channel actually grants the campaign. A "drops enabled" tag is not sufficient, because the
  channel may be running a *different* campaign for the same game.
- **Precondition drops** — tiered campaigns require claiming tier 1 before tier 2 progresses.
- **Progress watchdog** — if no progress arrives for N minutes, re-check the inventory before
  concluding the channel is bad, because the websocket sometimes goes quiet.
- **Channel cooldown list** — a channel that fails repeatedly is benched temporarily.
- **Self-correction** — progress may land on a different drop than intended; treat that as
  success rather than a stall.
- **Impossible campaigns** — a campaign that cannot finish before expiry is sometimes worth
  attempting anyway, because campaigns get extended.

### Why it stopped working

1. **`failed integrity check` / "BAD BOT"** (issues #298, #236, #212) — the dominant failure.
   The bot explicitly POSTed to `gql.twitch.tv/integrity` for a token, and Twitch returned one
   marked `"is_bad_bot":"true"`. Claiming drops then failed. Its own source contains a
   `if (decoded.includes('"is_bad_bot":"true"'))` check, so the author knew and never solved it.
2. **"Your browser is not currently supported"** (#284) — Twitch detects and blocks the
   `puppeteer-extra-plugin-stealth` browser outright.
3. **Login broken** (#267, #308, #203) — it scraped `#login-username` / `#password-input` and
   matched English UI strings by XPath to detect 2FA prompts. Twitch redesigned the page.
4. **Puppeteer API rot** — `page.waitForXPath()` and `page.waitForTimeout()` were removed from
   Puppeteer itself after this code was written.
5. **Stale GQL hashes** — Twitch rotates persisted-query hashes; several here are long dead.
6. **Brittle DOM selectors** — viewer count and uptime were read from
   `p[data-a-target="animated-channel-viewers-count"]` and `span.live-time`.

The structural lesson: **every one of these failures comes from driving a browser.** The
GraphQL layer was fine; the automation surface was the liability.

## DevilXD/TwitchDropsMiner (Python, no browser)

**Actively maintained — last commit August 2026.** This is the architecture this project follows.

### The three things it does differently

**1. Login is the OAuth device-code flow.**
`POST id.twitch.tv/oauth2/device` returns an 8-character code; the user enters it at
`twitch.tv/activate`; the bot polls `oauth2/token` until approved. No password touches the
process, and there is no DOM to scrape — this immunises the bot against login page redesigns
and 2FA changes, killing three of the original's top issues outright.

**2. It authenticates as the Android app, which sidesteps integrity entirely.**
`twitch.py` sets `ClientType.ANDROID_APP` - client ID `kd1unb4b3q4t58fwlpcbzcbnm76a8fp`,
with a Dalvik user-agent. This is the single most important detail in the whole project.

Twitch gates the drops operations behind an `IntegrityCheckFailed` challenge for the **web**
client ID. Verified against live Twitch (2026-08) with a real account:

| Request | Result |
| --- | --- |
| Web client ID, no auth | `IntegrityCheckFailed` |
| Web client ID + valid OAuth token | `IntegrityCheckFailed` |
| Android client ID + *web-issued* token | `IntegrityCheckFailed` |
| Android client ID + Android-issued token | works |

Two things follow. An OAuth token does **not** satisfy the integrity challenge - an earlier
assumption here that it did was wrong. And swapping only the `Client-Id` header is not
enough: the token must be *issued by* that client, so the device-code login and every
subsequent GQL request have to use the Android identity consistently.

The original bot's failure now makes sense: it authenticated as the web client, then asked
`gql.twitch.tv/integrity` for a token and got flagged `is_bad_bot`. The fix is not to solve
the challenge but to be a client that is not challenged.

**3. Watching is a single analytics POST.**
Twitch's player reports viewing by POSTing a base64'd `minute-watched` event to a per-channel
"Spade" endpoint. Sending that event directly advances drop progress — no video, no browser,
negligible bandwidth. The Spade URL is not exposed by any API; it must be scraped from the
channel page or the `settings.<hash>.js` bundle it loads.

Note commit `4148c71` (2026-07-11): *"Change the watching method back to using Spade"*. Twitch
has moved between mechanisms more than once, so this project implements the HLS-chunk
fallback (`GET` playlist, `HEAD` the last segment) alongside it.

### Other details adopted

- `ONLINE_DELAY` — a stream that just came up does not credit watch time for ~2 minutes.
- ~59s watch interval (one beat per credited minute).
- PubSub topics sharded across multiple sockets to track many channels at once.
- PING every 3 minutes with a PONG timeout that forces reconnect — a silently dead socket
  costs drop progress.
- The game *directory* query needs a URL **slug**, not the display name.
- HTTP redirects must be followed. Presenting the Android user-agent to `twitch.tv/<channel>`
  earns a 302 to `m.twitch.tv`; aiohttp follows it silently, which is what their "for mobile
  view" note refers to. Any client that does not follow redirects sees an empty body and
  fails to find the Spade URL.

## Verified live (2026-08-20)

All 12 persisted-query hashes used by this project were confirmed against
`gql.twitch.tv/gql` — see `npm run check-hashes`. The device-code login flow was confirmed
end to end, returning a real activation code.
