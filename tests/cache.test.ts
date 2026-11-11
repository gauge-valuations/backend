// Report cache: address keys, hit/miss behavior, failure tolerance, Upstash adapter.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeAddressKey } from "@/lib/address";
import { createCache, MemoryCache, UpstashCache, type ReportCache, type UpstashLikeClient } from "@/lib/cache";
import { UPSTASH_ENV_PAIRS } from "@/lib/cache/config";
import { PINNED_CACHE_TTL_SECONDS, REPORT_CACHE_TTL_SECONDS, reportCacheKey } from "@/lib/property/handler";

import { addressRouter, LISTED_ADDRESS, SKIP_NO_FIXTURES, UNLISTED_ADDRESS } from "./helpers/fixtures";
import { callProperty } from "./helpers/request";

/** Our own env var name pair (tests never spell the names out). */
const OWN = UPSTASH_ENV_PAIRS[0];

describe("normalizeAddressKey", () => {
  test("spacing, case, commas and USPS words collapse to one key", () => {
    assert.equal(normalizeAddressKey("3901 Prentice Ln, Austin, TX 78746"), "3901 prentice ln austin tx 78746");
    assert.equal(
      normalizeAddressKey("3901  prentice lane austin texas 78746"),
      normalizeAddressKey("3901 Prentice Ln, Austin, TX 78746"),
    );
    assert.equal(normalizeAddressKey("12 North Main Street."), "12 n main st");
  });
  test("different zip or house number -> different key", () => {
    const base = normalizeAddressKey("3901 Prentice Ln Austin TX 78746");
    assert.notEqual(normalizeAddressKey("3901 Prentice Ln Austin TX 78747"), base);
    assert.notEqual(normalizeAddressKey("3902 Prentice Ln Austin TX 78746"), base);
  });
  test("unit numbers stay in the key", () => {
    const unit = normalizeAddressKey("935 La Posada Dr, Ste 212, Austin, TX 78752");
    assert.ok(unit.includes("ste 212"), unit);
    assert.notEqual(unit, normalizeAddressKey("935 La Posada Dr, Ste 213, Austin, TX 78752"));
    assert.notEqual(unit, normalizeAddressKey("935 La Posada Dr, Austin, TX 78752"));
    assert.ok(normalizeAddressKey("10 Elm St Apt 4.5").endsWith("apt 4.5"), "decimal kept");
  });
});

describe("MemoryCache", () => {
  test("incrBy counts up, keeps the first expiry, and restarts after it", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache(() => now);
    assert.equal(await cache.incrBy("c", 4, 10), 4);
    now += 5_000;
    assert.equal(await cache.incrBy("c", 4, 10), 8); // expiry not extended
    now += 5_000;
    assert.equal(await cache.incrBy("c", 4, 10), 4); // expired at +10s -> fresh counter
  });

  test("expires entries after the TTL", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache(() => now);
    await cache.set("k", "v", 10);
    assert.equal(await cache.get("k"), "v");
    now += 9_999;
    assert.equal(await cache.get("k"), "v");
    now += 1;
    assert.equal(await cache.get("k"), null);
  });
});

/** Records set() calls; otherwise a normal in-memory cache. */
function recordingCache() {
  const inner = new MemoryCache();
  const sets: { key: string; ttl: number }[] = [];
  const cache: ReportCache = {
    shared: false,
    get: (key) => inner.get(key),
    set: async (key, value, ttl) => {
      sets.push({ key, ttl });
      await inner.set(key, value, ttl);
    },
    incrBy: (key, amount, ttl) => inner.incrBy(key, amount, ttl),
  };
  return { cache, inner, sets };
}

describe("report caching", { skip: SKIP_NO_FIXTURES }, () => {
  test("second request: zero fetch calls, identical body, X-Cache HIT", async () => {
    const { cache, sets } = recordingCache();
    const first = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-cache"), "MISS");
    assert.equal(first.calls.length, 4);
    // Prentice Ln is a pinned sample address, so it gets the 30-day TTL (budget.test.ts
    // covers pinned vs non-pinned); the default TTL stays 86400.
    assert.deepEqual(sets, [{ key: reportCacheKey(LISTED_ADDRESS), ttl: PINNED_CACHE_TTL_SECONDS }]);
    assert.equal(REPORT_CACHE_TTL_SECONDS, 86_400);

    const second = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache } });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-cache"), "HIT");
    assert.deepEqual(second.calls, []);
    assert.equal(second.text, first.text);
  });

  test("an address that normalizes to the same key also hits", async () => {
    const { cache } = recordingCache();
    await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache } });
    const variant = await callProperty("3901  prentice lane austin texas 78746", addressRouter(), { deps: { cache } });
    assert.equal(variant.headers.get("x-cache"), "HIT");
    assert.deepEqual(variant.calls, []);
  });

  test("a different address misses", async () => {
    const { cache } = recordingCache();
    await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache } });
    const other = await callProperty(UNLISTED_ADDRESS, addressRouter(), { deps: { cache } });
    assert.equal(other.headers.get("x-cache"), "MISS");
    assert.equal(other.calls.length, 4);
  });

  test("a 502 is not cached; the next request goes upstream again", async () => {
    const { cache, sets } = recordingCache();
    const failing = await callProperty(LISTED_ADDRESS, addressRouter({ "/avm/value": { status: 503, body: {} } }), { deps: { cache } });
    assert.equal(failing.status, 502);
    assert.deepEqual(sets, []);
    const retry = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache } });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("x-cache"), "MISS");
    assert.equal(retry.calls.length, 4);
  });

  test("a corrupt cached value is treated as a miss", async () => {
    for (const corrupt of ["{not json", JSON.stringify({ property: "nope" })]) {
      const { cache, inner } = recordingCache();
      await inner.set(reportCacheKey(LISTED_ADDRESS), corrupt, 60);
      const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-cache"), "MISS");
      assert.equal(r.calls.length, 4);
      assert.ok(r.logs.includes("cache entry invalid"));
      assert.ok(!r.logs.some((l) => l.includes(corrupt)));
    }
  });

  test("a throwing cache get/set does not break the request", async () => {
    // Only get/set fail here; the budget counter works. (A failing counter fails
    // CLOSED instead -- see budget.test.ts.)
    const counter = new MemoryCache();
    const broken: ReportCache = {
      shared: false,
      get: async () => {
        throw new Error("redis down: secret-ish detail");
      },
      set: async () => {
        throw new Error("redis down: secret-ish detail");
      },
      incrBy: (key, amount, ttl) => counter.incrBy(key, amount, ttl),
    };
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache: broken } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.logs, ["cache read failed", "cache write failed"]);
    assert.ok(!r.logs.some((l) => l.includes("secret-ish")));
  });
});

describe("Upstash cache adapter (fake client)", () => {
  const TOKEN = "upstash-token-sentinel-91ac";

  function fakeClient() {
    const store = new Map<string, string>();
    const calls: { op: string; key: string; ex?: number; n?: number }[] = [];
    const client: UpstashLikeClient = {
      async get(key) {
        calls.push({ op: "get", key });
        return store.get(key) ?? null;
      },
      async set(key, value, options) {
        calls.push({ op: "set", key, ex: options.ex });
        store.set(key, value);
        return "OK";
      },
      async incrby(key, amount) {
        calls.push({ op: "incrby", key, n: amount });
        const total = Number(store.get(key) ?? 0) + amount;
        store.set(key, String(total));
        return total;
      },
      async expire(key, seconds) {
        calls.push({ op: "expire", key, ex: seconds });
        return 1;
      },
    };
    return { client, calls };
  }

  test("counter: INCRBY, with EXPIRE only when the key is created", async () => {
    const { client, calls } = fakeClient();
    const cache = new UpstashCache(client);
    assert.equal(await cache.incrBy("budget:rentcast:2026-11", 4, 3_456_000), 4);
    assert.equal(await cache.incrBy("budget:rentcast:2026-11", 4, 3_456_000), 8);
    assert.deepEqual(calls, [
      { op: "incrby", key: "budget:rentcast:2026-11", n: 4 },
      { op: "expire", key: "budget:rentcast:2026-11", ex: 3_456_000 },
      { op: "incrby", key: "budget:rentcast:2026-11", n: 4 },
    ]);
  });

  test("stores and reads back a value with the TTL as EX", async () => {
    const { client, calls } = fakeClient();
    const cache = new UpstashCache(client);
    assert.equal(await cache.get("report:v1:x"), null);
    await cache.set("report:v1:x", '{"a":1}', 86_400);
    assert.equal(await cache.get("report:v1:x"), '{"a":1}');
    assert.deepEqual(calls[1], { op: "set", key: "report:v1:x", ex: 86_400 });
  });

  test("re-serializes a value the client already parsed", async () => {
    const cache = new UpstashCache({
      get: async () => ({ a: 1 }),
      set: async () => "OK",
      incrby: async () => 0,
      expire: async () => 1,
    });
    assert.equal(await cache.get("k"), '{"a":1}');
  });

  test("selection: Upstash when both env vars are set; log never has the token", async () => {
    const logs: string[] = [];
    const { client } = fakeClient();
    const env = { [OWN.url]: "https://fake-upstash.example.io", [OWN.token]: TOKEN };
    const cache = createCache({ env, log: (l) => logs.push(l), createUpstashClient: () => client });
    assert.ok(cache instanceof UpstashCache);
    await cache.set("k", "v", 5);
    assert.equal(await cache.get("k"), "v");
    assert.deepEqual(logs, ["cache: upstash"]);
    assert.ok(!logs.some((l) => l.includes(TOKEN) || l.includes("fake-upstash")));
  });

  test("selection: in-memory when either env var is missing, one safe log line", () => {
    for (const env of [{}, { [OWN.url]: "https://fake-upstash.example.io" }, { [OWN.token]: TOKEN }]) {
      const logs: string[] = [];
      const cache = createCache({ env, log: (l) => logs.push(l), createUpstashClient: () => assert.fail("must not build a client") });
      assert.ok(cache instanceof MemoryCache);
      assert.deepEqual(logs, ["cache: in-memory"]);
    }
  });
});
