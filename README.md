# gauge-backend

The API behind **Gauge Valuations**, an app that takes a US address and returns an
estimated value, comparable homes, a rent estimate and local market context. It is a
small Next.js (TypeScript) service on Vercel. It calls the Rentcast property data API
on the server, runs its own valuation engine over the comparable homes, and returns one
JSON report. The client never sees the data-provider key.

- Live web app: https://gauge-valuations.vercel.app
- Mobile app (Expo / React Native): https://github.com/gauge-valuations/mobile

## How the valuation works

Rentcast returns its own automated valuation (AVM) plus the comparable homes it used.
This service does not pass Rentcast's number through. It recomputes the estimate from
the comps (`lib/valuation/engine.ts`):

1. **Price per sqft per comp.** Comps without a usable price or square footage are skipped.
2. **Outlier filter.** With 5 or more comps, any comp whose $/sqft falls outside
   1.5 x IQR of the quartiles (the box-plot rule) is dropped.
3. **Weighted median.** Each comp is weighted by Rentcast's correlation score (0 to 1),
   Rentcast's measure of how similar the comp is to the subject property, not just how
   close it is. Distance alone would treat a nearby home of very different size as a
   better match than a similar home a few blocks further away. Comps without a positive
   score are left out of the calculation (they still appear in the comp list).
4. **Estimated value = weighted median $/sqft x the subject's square footage.** The
   weighted 25th and 75th percentiles x square footage give the value range.
5. **Fallback.** If fewer than 3 usable comps remain, the service uses Rentcast's own AVM
   number and range instead, and marks the valuation `lowConfidence: true`.

Rent uses the same steps on the rental comps.

### Worked example: 3901 Prentice Ln, Austin, TX 78746 (3,820 sqft)

From a captured Rentcast run (the numbers are reproduced by the offline engine tests):

- 15 sale comps; 2 dropped as $/sqft outliers; 13 used.
- Weighted median: **$701.73/sqft** x 3,820 sqft = **$2,680,604** estimated value.
- Engine range: $2,502,183 to $2,836,868.
- Rentcast's own AVM: $2,844,000 (range $2,588,000 to $3,100,000). The engine is
  **5.7% lower**, and both figures sit inside Rentcast's range.
- The home was listed at $2,195,000, so the app shows a potential margin of
  +$485,604 vs. list price (estimated value minus list price; the client computes it).
- Rent: engine **$10,837/month** ($2.84/sqft) vs. Rentcast's $11,580, **6.4% lower**.

A second address, 3712 Meredith St, Austin, TX 78703: engine $2,405,061 vs. Rentcast's
$2,326,000, **3.4% higher**.

These are two addresses, not an accuracy study.

## Limits

- **Comps are asking prices, not sale prices.** The comps are current listings
  (`for_sale`) and inactive listings (`off_market`, whose price is the last asking
  price, not a confirmed sale). Texas is a non-disclosure state, so recorded sale prices
  are not available there to check against. Asking prices can sit above or below what
  homes actually sell for.
- **An estimate, not an appraisal.** No one has inspected the home.
- **The rent range can be wide.** For 3901 Prentice Ln it is $9,037 to $16,447 a month.
  The 15 rent comps run from $1.52 to $5.12 per sqft, and the top four are luxury
  rentals at $4.31 to $5.12 per sqft ($15,500 to $19,500 a month). They are not extreme
  enough to be dropped as outliers. The median ($2.84/sqft, $10,837) is unaffected, but
  the 75th percentile lands on one of them ($4.31 x 3,820 sqft = $16,447), which sets
  the top of the range.
- **The rent fallback is silent.** With fewer than 3 usable rent comps, the rent
  becomes Rentcast's own number, and the report carries no low-confidence flag for
  rent (`lowConfidence` exists only on the valuation).
- **Incomplete records fail.** If Rentcast's record for the subject lacks beds, baths or
  square footage (common for condos and land), the request returns 502
  `upstream_incomplete` instead of a partial report. A missing year built or lot size is
  fine; those fields are simply omitted.
- **No listing, no margin.** An address that is not actively listed gets a full report
  with no `listPrice`, so the app shows no potential margin.
- **Address cleanup is display-only.** Rentcast sometimes splits a street name across
  two lines ("2305 Trail, of the Madrones, ..."); the report joins it back
  ("2305 Trail of the Madrones, ..."). This changes only the displayed address, never
  which comps are used or how they are weighted.

## API

### `GET /api/property?address=<address>`

Returns a `PropertyReport`. The shape is defined in [`lib/types.ts`](lib/types.ts),
which is a byte-for-byte copy of the mobile app's contract. Example, **trimmed** (one
comp and no rent comps shown; real responses carry all of them):

```json
{
  "property": {
    "address": "3901 Prentice Ln, Austin, TX 78746",
    "beds": 4,
    "baths": 4,
    "sqft": 3820,
    "yearBuilt": 1982,
    "lotSizeSqft": 34317,
    "lastSaleDate": "1992-03-18T00:00:00.000Z"
  },
  "valuation": {
    "estimatedValue": 2680604,
    "listPrice": 2195000,
    "pricePerSqft": 701.73,
    "valueRangeLow": 2502183,
    "valueRangeHigh": 2836868
  },
  "comps": [
    {
      "address": "3712 Meredith St, Austin, TX 78703",
      "beds": 4,
      "baths": 4,
      "sqft": 3413,
      "price": 2395000,
      "status": "off_market",
      "distanceMiles": 0.5986,
      "pricePerSqft": 702
    }
  ],
  "rent": {
    "monthlyRent": 10837,
    "rentPerSqft": 2.84,
    "rentRangeLow": 9037,
    "rentRangeHigh": 16447,
    "rentComps": []
  },
  "market": { "zip": "78746", "medianPrice": 2150000, "avgDaysOnMarket": 90.41 }
}
```

Notes:

- `potentialMargin` is never sent; the client derives it as estimated value minus list price.
- `lowConfidence` appears only when it is `true`.
- `lastSalePrice`, `yearBuilt` and `lotSizeSqft` are omitted when Rentcast lacks them.
- Comp `pricePerSqft` is whole dollars for sale comps and dollars with cents for rent
  comps (monthly rent per sqft).

Headers:

- **Request** `X-Demo-Key`: required when the server has `DEMO_KEY` set (see below).
- **Response** `X-Cache: HIT | MISS`: whether the report came from the cache.

Errors return `{ "error": "<code>", "message": "<fixed text>" }`. Messages are fixed
strings; no upstream text is passed through.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_address` | Address missing, too short or long, has control characters, or Rentcast rejected it. |
| 401 | `unauthorized` | Demo gate is on and `X-Demo-Key` is missing or wrong. |
| 402 | `upstream_billing` | Our monthly call budget is used up or could not be checked, or Rentcast reported a billing, quota or subscription problem. |
| 404 | `not_found` | Rentcast has no property record for this address. |
| 500 | `internal_error` | Server problem, e.g. the Rentcast key is missing or Rentcast rejected it. |
| 502 | `upstream_unavailable` | Rentcast timed out, failed, returned a 5xx, or rate-limited us (a Rentcast 429 maps to 502). |
| 502 | `upstream_incomplete` | Rentcast answered without data the report requires (see Limits). |

`OPTIONS /api/property` answers the browser CORS preflight (204). It is never gated.

### `GET /api/health`

Returns `{ "ok": true }`. Not gated, makes no upstream call.

## Architecture and safety

**Request order** for `GET /api/property` (`lib/property/handler.ts`):

1. CORS headers
2. Demo gate
3. Address validation
4. Cache lookup (a hit returns here)
5. Monthly budget reservation (cache misses only)
6. Build the report (4 Rentcast calls: value AVM, rent AVM, sale listing, market stats)
7. Cache write (successful reports only)

The report is checked against the shared contract before it is sent or cached.

**The Rentcast key stays on the server.** `lib/rentcast/client.ts` is the only code that
reads it. It goes into one request header and nowhere else: not into logs, errors or
responses. Log lines are fixed text plus status codes, never addresses, bodies or keys.

**Caching** (`lib/cache/`). Upstash Redis when configured, otherwise an in-memory cache
per server process. Reports are cached for 24 hours; the app's two sample addresses
(`lib/pinnedAddresses.ts`) for 30 days. The key is `report:v2:` plus the normalized typed
address (case, spacing, commas and common words like "Lane" -> "ln"; unit numbers and
zip codes always stay in the key). **Rule:** bump the version in `REPORT_CACHE_PREFIX`
whenever the shape or content of a cached report changes, so old reports are never
served. A cache that fails or times out (1.5s) is treated as a miss; the request continues.

**Monthly call budget** (`lib/budget.ts`). Rentcast's Developer plan includes 50
requests per billing period, then charges $0.20 per request. One uncached report costs 4
requests. Before any Rentcast call, a cache miss reserves 4 calls on a counter; if that
would exceed `MONTHLY_CALL_BUDGET` (default 40), the request gets 402 and Rentcast is
never called. With the default, that is 10 uncached reports per billing period, which
stops new uncached reports before the paid range starts, so the demo should never be
billed. **This guard is our own code, not a Rentcast spending cap.** Rentcast itself
would keep serving and billing. The guard fails closed: if the counter store errors or
times out, or if production has no shared store (each instance would count separately),
uncached reports get 402. Reservations are not refunded when a call fails, so the
counter overstates spending, never understates it. Cache hits are free and unlimited.

**CORS** (`lib/cors.ts`). Only exact origins listed in `ALLOWED_ORIGINS` are echoed back;
no wildcard. Native apps don't send an Origin and are unaffected.

**Demo gate** (`lib/demoGate.ts`). When `DEMO_KEY` is set, requests need a matching
`X-Demo-Key` header (compared in constant time). This is a speed bump against casual
use of the quota, **not a secret**: the same value ships in the public web app and the
mobile bundle, so anyone can read it. The real protection against cost is the call
budget above.

## Setup

Requires Node.js 20.9+ (Next.js 16). `scripts/warm-cache.ts` runs as TypeScript directly
under Node, which needs Node 22.18+.

```bash
npm install
cp .env.example .env.local   # then fill in values; .env* files are gitignored
npm run dev
```

Environment variables (see `.env.example`):

| Variable | What it does | Where it comes from |
|---|---|---|
| `RENTCAST_API_KEY` | Rentcast API key. Secret; server only. | Rentcast dashboard |
| `DEMO_KEY` | Turns on the demo gate. Blank = gate off. Not a secret. | You choose it; the app sends the same value |
| `ALLOWED_ORIGINS` | Comma-separated exact origins allowed by CORS. Blank = no CORS headers. | Your web app's URL(s) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis for the cache and budget counter. Token is secret. | Upstash console |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | The same, under the names Vercel's Upstash integration sets. | Set automatically by the integration |
| `MONTHLY_CALL_BUDGET` | Max Rentcast calls per billing period. Blank = 40. | You choose it |
| `BILLING_DAY` | Day of month (1-28, UTC) the Rentcast plan renews. Blank = 1. | Your Rentcast billing date |
| `BASE_URL` | Used only by `scripts/warm-cache.ts`: the deployed backend to warm. | Your Vercel URL |

Upstash names (`lib/cache/config.ts`, the only code that knows them): either pair works,
and `UPSTASH_REDIS_REST_*` wins when both are complete. The url and token always come from
the same pair; a half pair is ignored, never completed from the other pair. Blank or
whitespace-only values count as unset. `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL` and
`REDIS_URL` are never used. With no complete pair, the in-memory cache is used, and in
production uncached reports are then refused (see the budget above).

## Scripts and tests

```bash
npm test            # node:test via tsx, fully offline
npx tsc --noEmit    # type check
npm run lint
```

Tests never touch the network. A fake `fetch` serves captured Rentcast responses from
`fixtures/rentcast/raw/`. Those captures are gitignored because they contain real
addresses and listing agents' contact details, so on a fresh clone the fixture-based
tests are skipped and the rest still run.

- **`scripts/warm-cache.ts`** pre-loads the cache for the sample addresses on a deployed
  backend: `node --env-file=.env.local scripts/warm-cache.ts`. It prints only address,
  HTTP status and `X-Cache`. **Each MISS spends 4 real Rentcast calls** from the monthly
  budget, so run it deliberately, e.g. once after a deploy that bumps the cache version.
- **`scripts/capture-fixture.ts`** saves one raw Rentcast response into the gitignored
  fixtures folder. Every run is a real, billable Rentcast call; it skips files that already exist.

## Repo layout

```
app/api/
  health/route.ts         GET /api/health
  property/route.ts       GET + OPTIONS /api/property
lib/
  property/handler.ts     request order, cache, budget, errors
  property/report.ts      4 Rentcast calls -> PropertyReport
  valuation.ts            the one place that decides value and rent
  valuation/engine.ts     comp-based engine (pure functions)
  rentcast/               HTTP client and Rentcast response types
  cache/                  Upstash or in-memory cache; env name resolution
  budget.ts               monthly call budget
  address.ts              cache-key address normalization
  displayAddress.ts       display cleanup for split street names
  cors.ts, demoGate.ts, errors.ts, pinnedAddresses.ts
  types.ts                shared contract (copy of the mobile app's)
scripts/                  warm-cache.ts, capture-fixture.ts
tests/                    offline tests and helpers
```

## Status

Built and live:

- `GET /api/property` and `GET /api/health` on Vercel, used by the web app and the
  mobile app.
- The comp-based valuation and rent engine with Rentcast fallback.
- Caching, the monthly call budget, CORS allow-list and demo gate.

Not built (planned):

- A trained (ML) valuation model. Today's engine is the statistical method above.
- User accounts. There is no sign-in and no stored user data.

## License

MIT. See [LICENSE](LICENSE).
