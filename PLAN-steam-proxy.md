# Plan: Proxying Steam library data through SinfulShadows

**Goal:** a drops-bot user supplies a SinfulShadows API key instead of a personal Steam Web
API key. The bot calls SinfulShadows; SinfulShadows calls Steam with its own
`STEAM_API_KEY` and returns the library.

**Provider:** `/mnt/d/Projects/sinfulshadows` (NestJS backend, Nuxt frontend)
**Consumer:** `/mnt/d/Projects/twitch-drops-bot` (plain Node/TS daemon + Vue dashboard)

---

## 0. What already exists (and what this plan builds on)

Provider side:

- `backend/src/social/services/steam-api.service.ts` — `getOwnedGames`, `getPlayerSummary`,
  etc., already using the server-side key and already reporting usage through
  `SteamPresenceService.trackApiCall()`, which enforces awareness of the **100,000
  call/day** Steam budget (`STEAM_API_DAILY_LIMIT` in `steam-presence.service.ts`).
- Auth: `modules/auth/guards/jwt-auth.guard.ts` (`AuthGuard('jwt')`), a JWT strategy that
  reads the `accessToken` cookie or a Bearer header, `roles.guard.ts`, and a small OAuth2
  server (`oauth_clients` etc.) used for first-party SSO.
- Steam identity: users link Steam via OpenID (`social/strategies/steam.strategy.ts` →
  `SocialService.connectSteam()`), stored as a `UserSocialConnection` row with
  `platform = STEAM`, `platformUserId = <steamId64>`. `findBySteamId()` already exists.
- Caching: `@nestjs/cache-manager` + `cache-manager-redis-yet` are already wired per-module
  (blog, gamification). No `@nestjs/throttler` anywhere — rate limiting must be added.
- Frontend: `frontend/pages/settings/` already has `connections.vue`, `security.vue` — a
  natural home for an API-keys page.

Consumer side:

- `src/steam/client.ts` — `SteamClient` (undici, user's own key), `resolveSteamId()` which
  already resolves vanity URLs **without any key** via `steamcommunity.com/id/<x>/?xml=1`.
- `src/steam/library.ts` — `SteamLibrary.refresh(client, steamId)` is the only place the
  client is consumed for the library; caches to `steam.json`; already survives failed
  refreshes by keeping the stale cache (`src/index.ts:216-227`).
- Config: `config.steam = { apiKey?, steamId?, refreshHours }`.
- Dashboard: `web/src/views/Settings.vue` has the Steam card (sign-in button, ID field,
  API-key field, connect/refresh/disconnect against `/api/steam/*`).

---

## 1. Auth design: opaque API key, not JWT

The owner suggested JWT. **I recommend a long-lived opaque API key instead**, and I'd push
back on JWT plainly:

- **JWTs earn their complexity when verification must be stateless** (many services, no
  shared DB) or tokens are short-lived. Neither applies: there is exactly one backend, and
  a daemon on a Raspberry Pi wants a credential it can paste once and forget. A DB lookup
  per request is nothing at the traffic levels involved (one library fetch per user per
  day).
- **Revocation is the whole game here.** A long-lived JWT cannot be revoked without a
  denylist — which is a DB lookup, i.e. the thing JWT was supposed to avoid. A JWT with a
  `jti` checked against the DB *is* an opaque key with extra steps and a bigger payload.
- **Short-lived JWT + refresh flow** would force refresh-token plumbing, retry-on-401
  logic, and persistent token storage into the bot. That is real complexity in the
  consumer for zero benefit to the provider.
- **Blast radius:** keys signed with the existing `JWT_SECRET` share fate with every
  session cookie on the site. Opaque keys are independent random values; leaking one leaks
  one.

Where JWT stays: the **key-management endpoints** (create/list/revoke) are ordinary
browser-session endpoints guarded by the existing `JwtAuthGuard`. Only the
machine-to-machine data endpoints use the new API-key auth.

### Key semantics

- **A key identifies a user, not an application.** The privacy model (§4) is "you may read
  the Steam account *you* linked", which only works if the key resolves to a SinfulShadows
  user. Per-user attribution also makes abuse handling and revocation sane. There is no
  application-level key.
- **Scoped.** `scopes: string[]` on the key, checked by a `@Scopes('steam:library')`
  decorator. Ship with `steam:library` (covers library + profile-summary reads). It costs
  nothing now and avoids a migration when the next consumer wants a different capability.
- **Multiple keys per user** (a `name` field: "drops bot on pi", "desktop"), so one machine
  can be revoked without breaking the others.

### Format, storage, lifecycle

- Format: `ss_` + 40 chars base62 from `crypto.randomBytes` (~238 bits). The distinctive
  prefix makes leaked keys grep-able (GitHub secret scanning style) and instantly
  recognisable in the bot's UI.
- Store **SHA-256 of the key**, never the key. High-entropy random tokens don't need
  bcrypt; lookup is `WHERE key_hash = sha256(presented)` — indexed, constant cost. Keep
  `key_prefix` (first 12 chars) in plaintext for display ("ss_a8Xk3…").
- Shown **once** at creation in the frontend, copy button, never retrievable again.
- Entity (new table `api_keys`):

```ts
@Entity('api_keys')
class ApiKey {
  id; userId (FK → users, indexed); name;
  keyHash (unique, indexed); keyPrefix;
  scopes: string[];        // e.g. ['steam:library']
  lastUsedAt; createdAt; revokedAt (null = active);
}
```

- **Obtaining a key:** a new Nuxt page `frontend/pages/settings/api.vue` ("API keys"),
  self-service — no admin action needed. It lists keys (prefix, name, created, last used),
  creates (name + implicit `steam:library` scope), and revokes. Sits next to
  `connections.vue`, which is also where the user links Steam — the page should say
  plainly: *"These keys let external apps (e.g. the Twitch drops bot) read the Steam
  library linked to your account."*
- **Revoking:** sets `revokedAt`; the guard rejects with 401 `{"error":"key_revoked"}`.
  Admins can revoke any user's keys later via the existing admin module if abuse shows up
  — not needed for v1.

### Guard

A plain `CanActivate` (`ApiKeyGuard`), not a passport strategy — there is no session or
redirect flow to benefit from passport here, and the existing codebase's passport use is
all browser-auth. The guard:

1. Reads `Authorization: Bearer ss_…` (reject anything not starting `ss_` so JWTs can't
   accidentally hit these routes).
2. Hash → lookup → reject if missing/revoked.
3. Checks scopes required by the route's `@Scopes()` metadata.
4. Checks the per-key rate limit (§3) in Redis.
5. Attaches `{ userId, keyId, scopes }` to `request.apiKey`; fire-and-forget updates
   `lastUsedAt` (throttled to once a minute so it's not a write per request).

---

## 2. Provider endpoints

New module `backend/src/api-keys/` (entity + service + management controller + guard) and a
new controller in `social/` for the proxy itself — it belongs with `SteamApiService` and
imports it via the existing `SocialModule` providers rather than duplicating anything.

Routes (matching the existing `api/…` controller-path convention, versioned from day one):

```
GET /api/v1/steam/library     Guard: ApiKeyGuard  Scope: steam:library
GET /api/v1/steam/profile     Guard: ApiKeyGuard  Scope: steam:library   (optional, v1.1)
GET /api/v1/me                Guard: ApiKeyGuard  (no scope — key introspection)
```

`GET /api/v1/me` returns `{ userId, username, scopes, steam: { linked, steamId,
personaName } }` — the bot uses it as its "test connection" call and to show *whose*
library it will mine.

**`GET /api/v1/steam/library`** takes **no `steamId` parameter** (see §4). Flow:

1. Resolve the caller's linked Steam account:
   `SocialService.getSocialConnections(userId)` filtered to `STEAM`. None → `409
   {"error":"steam_not_linked", "link_url":"https://sinfulshadows.com/settings/connections"}`.
2. Serve from Redis cache if fresh (§3).
3. Else call `SteamApiService.getOwnedGames(steamId)` + `getPlayerSummary(steamId)`
   (summary cached far longer; it's only for `personaName`).
4. Map to a **stable DTO** — do not pass Steam's raw shape through; the proxy's contract
   must survive Steam tweaks and deliberately mirrors the bot's `OwnedGame`:

```json
{
  "steamId": "76561198000000000",
  "personaName": "Nathan",
  "fetchedAt": 1756000000000,
  "stale": false,
  "games": [
    { "appid": 252490, "name": "Rust",
      "playtimeForever": 12345, "playtimeRecent": 120, "lastPlayed": 1755400000 }
  ]
}
```

`SteamApiService.getOwnedGames()` is reused as-is (Steam's `v0001` *is* v1 — zero-padded
version strings are the same interface; the response includes `rtime_last_played` when
Steam permits it). One addition to the service: the current method returns
`data.response.games || []`, discarding `game_count` — the DTO mapper should live in the
new controller/service layer, not change `SteamApiService`'s existing signature, since
`social.service.ts` and gamification depend on it.

**A caveat to document in both repos:** Steam only returns `rtime_last_played` reliably
when the querying key belongs to the queried account (the bot's own `client.ts` documents
this). Via the proxy that is never the case, so `lastPlayed` may be `0` for every game.
The bot's `steam_recent` mode already falls back to total playtime for never-played games
(`library.ts` `score()`); extend that: when *no* game has `lastPlayed`, fall back to
`playtimeRecent` (two-week playtime, which *is* returned publicly) and then playtime. The
proxy passes `playtime_2weeks` through precisely for this.

Also enforce the same "empty = probably private" rule the bot has: if Steam returns zero
games, respond `409 {"error":"library_private"}` with a human message about the "Game
details" privacy setting — don't cache it, don't return an empty 200 the bot would
happily treat as an empty library.

---

## 3. Abuse and cost control

The site's Steam key becomes shared infrastructure; protect it in four layers:

1. **Response cache (the big one).** Redis via the existing cache-manager pattern:
   `steam-proxy:library:<steamId>` with a **6-hour fresh TTL**, plus a long-lived copy
   (`…:stale`, 7-day TTL) for fallback. Libraries change rarely — the bot itself defaults
   to a 24 h refresh — so even a hammering client costs Steam at most 4 calls/day per
   linked account. 1,000 active users ≈ 4–8 k Steam calls/day against a 100 k budget.
2. **Per-key rate limit.** Simple Redis fixed-window counter in `ApiKeyGuard`
   (`ratelimit:<keyId>:<hourBucket>`): **30 requests/hour** across the v1 routes. That is
   ~30× what a well-behaved bot needs and still nothing at Steam's scale. Over → `429`
   with `Retry-After`. `@nestjs/throttler` isn't installed and its IP-based default is the
   wrong axis here; a 15-line counter keyed on the API key is less machinery than
   installing and configuring it. (If the project later wants site-wide throttling, adopt
   throttler then and fold this in.)
3. **Global Steam budget.** Every proxy-originated Steam call goes through the existing
   `SteamPresenceService.trackApiCall()` with a new category (`proxyLibrary`), so it shows
   up in the same budget accounting the presence poller already respects. If remaining
   budget is critically low, serve stale cache only (`stale: true`) instead of calling
   Steam.
4. **Steam slow/down.** Timeout Steam calls at ~10 s. On failure: serve the stale copy
   with `"stale": true` and its original `fetchedAt`; if no stale copy exists, `503
   {"error":"steam_unavailable"}` with `Retry-After: 600`. Never let a Steam outage
   hold requests open or cascade.

Log per-key usage counts (key prefix + userId, never the key) so a misbehaving consumer is
identifiable.

---

## 4. Privacy: linked accounts only

**Recommendation: a key may only read the Steam account its owner has linked via Steam
OpenID on SinfulShadows. The endpoint takes no `steamId` parameter at all.**

The alternative — accept any steamId — would make the site an anonymous-ish open proxy for
enumerating anyone's game library on SinfulShadows' key and IP. Yes, `GetOwnedGames` only
returns what the target's privacy settings already make public, so this is not a hard
privacy hole; but it turns the service into a scraping vector, burns the shared budget on
strangers' accounts, and makes SinfulShadows answerable for the traffic pattern. There is
no legitimate drops-bot use case for reading someone else's library — the bot mines for
the account that owns it.

Deriving the steamId server-side (rather than validating a client-supplied one against the
link) also simplifies the bot: with the SinfulShadows provider selected, the user enters
**one** credential and no Steam ID; identity comes from the link. The Steam OpenID linking
flow already exists on the site (`connections.vue`), which is a stronger proof of control
than anything the bot could do — it's the same OpenID sign-in the bot already offers, but
performed against the account that owns the key.

Consequence to surface in the bot's UI: if the user's SinfulShadows account has no Steam
link, `/api/v1/steam/library` returns `steam_not_linked` and the bot shows "Link Steam on
sinfulshadows.com → Settings → Connections, then retry" with the URL from the response.

---

## 5. Drops-bot changes

### Provider abstraction

`SteamLibrary.refresh(client, steamId)` is the single consumption point — introduce a
minimal interface and keep `SteamLibrary` untouched apart from its parameter:

```ts
// src/steam/provider.ts
export interface LibrarySnapshot {
    steamId: string;
    personaName: string;
    games: OwnedGame[];
    /** True when the provider served cached data because Steam was unreachable. */
    stale?: boolean;
}
export interface LibraryProvider {
    fetchLibrary(): Promise<LibrarySnapshot>;
    /** Human label for logs/UI: "Steam (your key)" / "SinfulShadows". */
    readonly label: string;
}
```

- `DirectSteamProvider` wraps the existing `SteamClient` + configured `steamId` (moves the
  getOwnedGames + getProfile + "empty means private" logic that's currently inside
  `SteamLibrary.refresh`).
- `SinfulShadowsProvider` — one undici GET to
  `${baseUrl}/api/v1/steam/library` with `Authorization: Bearer <key>` and a
  `twitch-drops-bot/<version>` User-Agent. Maps `401 → "key invalid or revoked"`,
  `409 steam_not_linked → actionable message with link URL`, `409 library_private →
  privacy-settings message`, `429/5xx → retryable SteamError`. No steamId input at all.

`SteamLibrary.refresh(provider: LibraryProvider)` replaces the current signature.
`resolveSteamId()` and `openid.ts` remain for the direct path only.

### Config

```jsonc
"steam": {
    "provider": "direct",            // "direct" | "sinfulshadows"
    "apiKey": "…",                   // direct only
    "steamId": "…",                  // direct only
    "sinfulshadows": {
        "apiKey": "ss_…",
        "baseUrl": "https://api.sinfulshadows.com"   // default; overridable for dev
    },
    "refreshHours": 24
}
```

Migration in `loadConfig()` (same pattern as the existing `mineUnlistedGames` migration):
`provider` absent → `"direct"`. **Existing setups keep working with zero action.**

### Daemon API + Settings UI

- `/api/steam` (status) gains `provider`, and for sinfulshadows: `connected`,
  `personaName`, `stale`. `/api/steam/connect` accepts either
  `{ provider: "direct", apiKey, steamId }` (unchanged behaviour) or
  `{ provider: "sinfulshadows", apiKey }` — the latter validates by calling `/api/v1/me`
  and immediately fetching the library.
- `Settings.vue` Steam card becomes two tabs/radio options:
  - **"SinfulShadows account"** (listed first — it's the easier path): one password field
    for the `ss_…` key, helper text "Create a key at sinfulshadows.com → Settings → API
    keys. Your library comes from the Steam account linked there — no Steam API key
    needed." Shows the linked persona after connect, and the actionable error states from
    above (`steam_not_linked`, `library_private`, key revoked).
  - **"Your own Steam key"** — the existing UI exactly as it is (OpenID button, profile
    URL field, key field), for anyone not on SinfulShadows.
- README: document both paths; keep the direct-key section, add the SinfulShadows section;
  note the `lastPlayed`/`steam_recent` caveat from §2.

### Failure modes (consumer)

Already mostly handled by design: `steam.json` persists and a failed refresh keeps the
stale library (`index.ts:216-227` logs and continues). Additions:

- SinfulShadows unreachable / 5xx / 429 → same path as a failed direct refresh: warn,
  keep the cache, try again next `refreshHours` cycle. No tight retry loop.
- `401` (revoked/invalid key) → warn distinctly ("SinfulShadows key rejected — create a
  new one"), surface as a warning state on the Settings card, and send one notification
  through the existing notifiers. Keep mining with the cached library; do not clear it.
- `stale: true` in the response → accept it, store it, but keep the previous `fetchedAt`
  semantics honest (store the server's `fetchedAt`, not `Date.now()`), so the bot retries
  sooner rather than treating stale data as a fresh 24 h sync.

---

## 6. Migration and rollout

- **Provider:** additive only — one new table (`api_keys`), one new module, one new
  controller, one frontend page. No existing route or entity changes. Deployable ahead of
  any bot change.
- **Consumer:** config migration is silent (§5); `steam.json` format is unchanged
  (`StoredLibrary` already carries everything the proxy returns). A user switches by
  picking the SinfulShadows tab and pasting a key; switching back is equally lossless.
- **Order:** ship the provider first, verify with `curl`, then the bot PR.

---

## 7. Task list

### SinfulShadows (backend + frontend) — ~2.5 days

| # | Task | Effort |
|---|------|--------|
| 1 | `ApiKey` entity + TypeORM migration (`api_keys` table, indexes on `key_hash`, `user_id`) | 1–2 h |
| 2 | `ApiKeyService`: generate (`ss_` + base62), hash, create/list/revoke, `verify(presented)` → `{userId, keyId, scopes}` with revocation check; throttled `lastUsedAt` update | 2–3 h |
| 3 | `ApiKeyGuard` (`CanActivate`) + `@Scopes()` decorator + Redis fixed-window per-key limiter | 2–3 h |
| 4 | Key-management controller under the existing `JwtAuthGuard`: `GET/POST /api/account/api-keys`, `DELETE /api/account/api-keys/:id` | 1–2 h |
| 5 | `SteamProxyController` + `SteamProxyService` in `social/`: `/api/v1/me`, `/api/v1/steam/library`; linked-account resolution via `SocialService`, DTO mapping, Redis fresh+stale caching, private-library and Steam-down handling, `trackApiCall('proxyLibrary')` | 3–4 h |
| 6 | Unit tests (guard, service, controller — follow existing `*.spec.ts` patterns) + a curl smoke script | 2–3 h |
| 7 | Nuxt `pages/settings/api.vue`: list/create/revoke, show-once key modal with copy, nav entry; cross-link from `connections.vue` | 3–4 h |
| 8 | Ops: nothing new to configure (reuses `STEAM_API_KEY`, Redis); note the new endpoints in the API docs/README | 0.5 h |

### Twitch drops bot — ~1.5 days

| # | Task | Effort |
|---|------|--------|
| 1 | `src/steam/provider.ts` (`LibraryProvider`, `LibrarySnapshot`); refactor `SteamLibrary.refresh()` to take a provider; `DirectSteamProvider` wrapping current logic | 1–2 h |
| 2 | `SinfulShadowsProvider` (undici, error mapping incl. `steam_not_linked` / `library_private` / 401 / 429) | 2 h |
| 3 | Config: `provider` field + `sinfulshadows` block, silent migration in `loadConfig()`, defaults | 1 h |
| 4 | Daemon API: extend `/api/steam` status and `/api/steam/connect`; distinct 401-revoked handling + one-shot notifier warning | 1–2 h |
| 5 | `Settings.vue`: provider tabs, SinfulShadows connect flow, error/linked states | 2–3 h |
| 6 | `steam_recent` fallback chain (`lastPlayed → playtimeRecent → playtimeForever`) for proxied libraries | 0.5 h |
| 7 | README: SinfulShadows section, caveats; manual test pass against the live endpoint | 1 h |

---

## 8. Decisions made vs. the original suggestion

1. **Opaque API key instead of JWT** — revocation, daemon ergonomics, and blast radius all
   favour it; a revocable JWT degenerates into an opaque key anyway (§1).
2. **Key identifies a user, with scopes** — required by the privacy model; scopes are
   near-free future-proofing (§1).
3. **No `steamId` parameter on the proxy** — linked-account-only, resolved server-side.
   The strongest privacy stance and the simplest consumer (§4).
4. **Hand-rolled Redis counter over `@nestjs/throttler`** — the needed axis is per-key,
   not per-IP, and the counter is smaller than the dependency (§3).
5. **Serve-stale-on-failure with an explicit `stale` flag** — a drops miner strongly
   prefers slightly old data over none; both sides already lean that way (§3, §5).
