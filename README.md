# Twitch Drops Bot

A browserless Twitch drop miner. No Chrome, no Puppeteer, no video download — it talks to
Twitch's GraphQL API directly and reports watch time the same way the web player does.

Written after studying [TychoTheTaco/Twitch-Drops-Bot][tycho] (the Puppeteer bot, dead since
2023) and [DevilXD/TwitchDropsMiner][devilxd] (Python, actively maintained). See
[ANALYSIS.md](ANALYSIS.md) for what each got right and why the browser-based one broke.

[tycho]: https://github.com/TychoTheTaco/Twitch-Drops-Bot
[devilxd]: https://github.com/DevilXD/TwitchDropsMiner

## Why no browser

Every failure that killed the older bot traces back to driving Chrome: Twitch blocking the
stealth browser, the login page being rescraped after every redesign, DOM selectors rotting,
and integrity checks flagging automated browsers as bots. The GraphQL layer was never the
problem. This bot keeps that layer and throws the browser away.

Practical effect: a few HTTPS requests per minute and some idle websockets. Runs comfortably
on a Raspberry Pi.

## Setup

Requires Node 20+.

```sh
npm install
npm run build
npm start
```

On first run it writes a default `config.json` and prints a login code:

```
==========================================================
  Authorize this bot with your Twitch account:
  1. Open https://www.twitch.tv/activate?device-code=XXXXXXXX
  2. Enter the code:  XXXXXXXX
==========================================================
```

Open the link, enter the code, and the bot starts mining. Credentials are saved to
`auth.json` (mode 0600) and reused on later runs.

This uses the **OAuth device-code flow** — your password never touches this process, and
there is no 2FA prompt to scrape. To sign out, run with `--logout`.

> `auth.json` grants access to your Twitch account. Do not share or commit it. It is
> git-ignored by default.

## Configuration

`config.json`:

| Option | Default | Meaning |
| --- | --- | --- |
| `priorityGames` | `[]` | Games to mine, most wanted first. Display names or game IDs. Empty means any. |
| `excludedGames` | `[]` | Never mine these. |
| `mineUnlistedGames` | `true` | Mine games outside `priorityGames`. |
| `preferredChannels` | `[]` | Try these channels before searching the directory. |
| `campaignRefreshMinutes` | `20` | Minutes between campaign refreshes (minimum 5). |
| `attemptImpossibleCampaigns` | `true` | Work on campaigns that look too short to finish — they often get extended. |
| `autoClaimDrops` | `true` | Claim drops as soon as they are ready. |
| `autoClaimPoints` | `true` | Claim channel points bonuses while watching. |
| `warnUnlinkedAccounts` | `true` | Warn when rewards will not reach the game because accounts are not linked. |
| `logLevel` | `"info"` | `error`, `warn`, `info`, or `debug`. |
| `notifications` | `{}` | Optional Telegram / Discord webhooks. |

Notifications:

```json
{
  "notifications": {
    "telegram": { "botToken": "...", "chatId": "..." },
    "discord":  { "webhookUrl": "https://discord.com/api/webhooks/..." }
  }
}
```

### CLI

```
-c, --config <path>   Config file (default: ./config.json)
-a, --auth <path>     Credential store (default: ./auth.json)
-l, --log <level>     error | warn | info | debug
    --logout          Discard stored credentials and log in again
-h, --help
```

## How it works

**Authentication** — OAuth device code. The resulting token is validated against
`id.twitch.tv/oauth2/validate`, which also yields the user ID every request needs.

**Finding work** — `ViewerDropsDashboard` lists campaigns, `DropCampaignDetails` fills in the
drops and channel allow-list, and `Inventory` supplies actual progress. Campaigns are ranked
by priority-list position, then soonest-ending, then fewest minutes remaining.

**Picking a channel** — preferred channels first (or the campaign's allow-list if it has
one), otherwise the game directory filtered to drops-enabled streams. Each candidate is
checked with `DropsHighlightService_AvailableDrops` to confirm it really grants *this*
campaign; a drops-enabled tag alone is not enough, since the channel may be running a
different campaign for the same game.

**Watching** — every 59 seconds the bot POSTs a base64'd `minute-watched` event to the
channel's Spade endpoint. That single request is what advances drop progress. If Spade fails,
it falls back to fetching a live HLS segment header, which Twitch also counts.

**Tracking** — a PubSub websocket pool delivers `drop-progress`, `drop-claim`, and stream
up/down events in real time. If PubSub goes quiet for 8 minutes, the bot re-reads the
inventory before giving up on a channel, then benches that channel for 30 minutes.

**Claiming** — `DropsPage_ClaimDropRewards` fires as soon as a drop reports claimable, and
anything that completed while the bot was offline is claimed on the next refresh.

## Maintenance

Twitch rotates the SHA256 hashes of its persisted GraphQL queries without warning. This is by
far the most likely reason the bot breaks. Check them first:

```sh
npm run check-hashes
```

Every hash reports `ok`, `ok (needs auth)`, or `STALE - hash rotated`. The bot also raises a
dedicated `StaleQueryHashError` at runtime rather than failing with a confusing null error.

### Updating a stale hash

1. Open twitch.tv in a browser with DevTools → Network, filtered to `gql`.
2. Trigger the relevant action (open the Drops page, a channel, etc.).
3. Find the request whose `operationName` matches, and copy
   `extensions.persistedQuery.sha256Hash` from the payload.
4. Update it in `src/twitch/constants.ts`.

Cross-checking [DevilXD/TwitchDropsMiner's `constants.py`][devilxd] is usually faster — it is
actively maintained and tracks these rotations.

### Other things that can break

- **`failed integrity check`** — should only occur on unauthenticated requests. If it appears
  while logged in, the token has gone stale: run with `--logout` and sign in again.
- **`Could not locate the Spade URL`** — Twitch changed the channel page layout. Update
  `SPADE_PATTERN` / `SETTINGS_PATTERN` in `src/models/channel.ts`.
- **Progress never advances** — Twitch has likely moved the watch mechanism again. The
  fallback in `sendWatchPlaylist()` is the first thing to try.

## Notes

- Rewards only reach the game if your Twitch account is linked to the publisher's account.
  The bot warns when it is not; it cannot link it for you.
- Watching Twitch in a browser on the same account while the bot runs will confuse progress
  tracking.
- One account per instance.

## Project layout

```
src/
  index.ts              CLI entry point
  config.ts             Config load + defaults
  miner.ts              Orchestrator: selection, watching, claiming
  models/
    campaign.ts         Campaign / Drop, priority ordering
    channel.ts          Channel + the Spade watch mechanism
  twitch/
    auth.ts             OAuth device-code flow, request headers
    gql.ts              GraphQL client, stale-hash detection
    constants.ts        Endpoints and persisted-query hashes
    websocket.ts        PubSub connection pool
    types.ts            API response shapes
  notifiers/            Telegram / Discord
  tools/check-hashes.ts Hash health check
```
