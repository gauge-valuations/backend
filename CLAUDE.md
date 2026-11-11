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

The same rules apply to the Upstash token (`UPSTASH_REDIS_REST_TOKEN`). `DEMO_KEY` is not
a secret (it ships in the app bundle) but is still never logged or echoed.

## Git

Never commit and never push. Read-only git commands are fine.
Never write `Co-Authored-By` or any tool/agent attribution into commits, PR bodies, or files.

## Definition of done

`npx tsc --noEmit` exits clean.

## Routes

- `GET /api/health` -> `{ "ok": true }`
- `GET /api/property?address=...` -> `PropertyReport` (see `lib/types.ts`), or
  `{ error, message }` with 400 / 401 / 402 / 404 / 500 / 502. Logic lives in `lib/property/`.
  - Returns the engine's `pricePerSqft` / `valueRangeLow` / `valueRangeHigh` (plus
    `lowConfidence: true` only when it applies) and `rentPerSqft` / `rentRangeLow` /
    `rentRangeHigh`. Every comp carries `pricePerSqft` (sale: whole dollars, rent: cents).
  - All value comps, in correlation order: Rentcast Active -> `for_sale`, Inactive ->
    `off_market` (never `sold`: off-market is not a confirmed sale).
  - `yearBuilt` / `lotSizeSqft` are omitted when Rentcast lacks them.
- `OPTIONS /api/property` -> CORS preflight (204). Never gated.

`lib/types.ts` is a byte-for-byte copy of the mobile repo's `src/types.ts` (the shared
contract), refreshed by `cp` only. Never edit it here; change it in the mobile repo
first, then re-copy and check `shasum`.

## CORS, demo gate, caching

- **CORS** (`lib/cors.ts`): `ALLOWED_ORIGINS` = comma-separated exact origins. A listed
  origin is echoed in `Access-Control-Allow-Origin`; no wildcard. `Vary: Origin` whenever
  the list is set; nothing at all when unset (native apps don't need CORS).
- **Demo gate** (`lib/demoGate.ts`): when `DEMO_KEY` is set, `/api/property` requires a
  matching `X-Demo-Key` header (constant-time compare) or returns 401 `unauthorized`
  before any cache or Rentcast access. A quota speed bump, not a secret: the matching
  value ships in the app bundle. Unset = gate off. `/api/health` stays open.
- **Caching** (`lib/cache/`): Upstash Redis when its URL and token env vars are set,
  otherwise in-memory (per process). Key `report:v1:<normalizeAddressKey(address)>`
  (`lib/address.ts`), TTL 86400s, successful reports only. Responses carry
  `X-Cache: HIT | MISS`. Cache read/write failures are non-fatal: logged as one safe line,
  and the request continues.
