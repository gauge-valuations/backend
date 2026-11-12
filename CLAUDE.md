# gauge-backend

Backend only. The Expo / React Native mobile app lives in a separate repo and calls
this service over HTTP. No UI code belongs here -- this is an API, not a website.

Next.js 16 (App Router), TypeScript strict, deployed on Vercel.

See @AGENTS.md for Next.js-version-specific guidance. **The rules in this file take
precedence over anything in AGENTS.md.**

## Secrets

The Rentcast API key is a server-side environment variable (`RENTCAST_API_KEY`) and
nothing else. It must never appear in:

- source code or config files
- commits (`.env*` is gitignored; only `.env.example`, which holds no value, is committed)
- logs, console output, or telemetry
- error responses or any response body returned to a client

The real value lives only in Vercel env vars and a password manager.

The same rules apply to the Upstash tokens (`UPSTASH_REDIS_REST_TOKEN`, or Vercel's
`KV_REST_API_TOKEN` / `KV_REST_API_READ_ONLY_TOKEN`). `DEMO_KEY` is not
a secret (it ships in the app bundle) but is still never logged or echoed.

## Git

Never commit and never push. Read-only git commands are fine.
Never write `Co-Authored-By` or any tool/agent attribution into commits, PR bodies, or files.

## Definition of done

`npx tsc --noEmit` exits clean.

## Routes

- `GET /api/health` -> `{ "ok": true }`
- `GET /api/property?address=...` -> `PropertyReport` (see `lib/types.ts`), or
  `{ error, message }` with 400 / 401 / 402 / 404 / 422 / 500 / 502. Logic lives in `lib/property/`.
  - Returns the engine's `pricePerSqft` / `valueRangeLow` / `valueRangeHigh` (plus
    `lowConfidence: true` only when it applies) and `rentPerSqft` / `rentRangeLow` /
    `rentRangeHigh`. Every comp carries `pricePerSqft` (sale: whole dollars, rent: cents).
  - All value comps, in correlation order: Rentcast Active -> `for_sale`, Inactive ->
    `off_market` (never `sold`: off-market is not a confirmed sale).
  - `yearBuilt` / `lotSizeSqft` are omitted when Rentcast lacks them.
  - Missing beds / baths / sqft / address (or a rent 400 once the value call resolved the
    address) -> 422 `incomplete_data` naming the fields; never guessed, never cached.
- `OPTIONS /api/property` -> CORS preflight (204). Never gated.

`lib/types.ts` is a byte-for-byte copy of the mobile repo's `src/types.ts` (the shared
contract), refreshed by `cp` only. Never edit it here; change it in the mobile repo
first, then re-copy and check `shasum`.

## CORS, demo gate, caching, call budget

- **CORS** (`lib/cors.ts`): `ALLOWED_ORIGINS` = comma-separated exact origins. A listed
  origin is echoed in `Access-Control-Allow-Origin`; no wildcard. `Vary: Origin` whenever
  the list is set; nothing at all when unset (native apps don't need CORS).
- **Demo gate** (`lib/demoGate.ts`): when `DEMO_KEY` is set, `/api/property` requires a
  matching `X-Demo-Key` header (constant-time compare) or returns 401 `unauthorized`
  before any cache or Rentcast access. A quota speed bump, not a secret: the matching
  value ships in the app bundle. Unset = gate off. `/api/health` stays open.
- **Caching** (`lib/cache/`): Upstash Redis when a complete url + token pair is set,
  otherwise in-memory (per process). `lib/cache/config.ts` is the only code that knows the
  names: `UPSTASH_REDIS_REST_URL`/`_TOKEN` first, then `KV_REST_API_URL`/`_TOKEN` (the pair
  Vercel's Upstash integration sets). Never mixed across pairs; the read-only token,
  `KV_URL` and `REDIS_URL` are ignored. Key `report:v2:<normalizeAddressKey(address)>`
  (`lib/address.ts`); bump the version (`REPORT_CACHE_PREFIX`) whenever the shape or
  content of a cached report changes. TTL 86400s, successful reports only. Responses carry
  `X-Cache: HIT | MISS`. Cache read/write failures are non-fatal: logged as one safe line,
  and the request continues.
- **Pinned addresses** (`lib/pinnedAddresses.ts`): the app's "Try these" samples, cached
  for 30 days (2,592,000s) instead of 24h, matched by normalized key. **This list must
  match `src/sampleAddresses.ts` in the mobile repo** -- two repos on purpose; change both.
- **Monthly call budget** (`lib/budget.ts`): a hard cap, because the Rentcast Developer plan
  bills $0.20 per call beyond 50. On a cache MISS only (after gate, validation and cache
  lookup), 4 calls are reserved on `budget:rentcast:YYYY-MM` (40-day TTL) before any Rentcast
  call; over `MONTHLY_CALL_BUDGET` (default 40) -> 402 `upstream_billing`, no call made. No
  refunds on failure. The period starts on `BILLING_DAY` (1-28, UTC, default 1); `YYYY-MM`
  is the month the current period started. **Fails closed**: if the counter store throws or
  times out (1.5s), or in production when the store isn't shared (no Upstash), uncached
  reports get 402. So a down Upstash means cache misses are refused, not paid for.
  Example: budget 40, billing day 9 -> 10 uncached reports per period (Nov 9 - Dec 8);
  the 11th gets 402 until Dec 9. Cache hits stay free and unlimited.
- **Warm-up** (`scripts/warm-cache.ts`): `node --env-file=.env.local scripts/warm-cache.ts`
  GETs each pinned address from `BASE_URL` (https, or http://localhost) with `X-Demo-Key`
  from `DEMO_KEY`, printing only address, status and `X-Cache`. Each MISS spends 4 budgeted
  calls. It imports `lib/pinnedAddresses.ts` with a `.ts` extension
  (`allowImportingTsExtensions` in tsconfig), so that file must stay import-free.
