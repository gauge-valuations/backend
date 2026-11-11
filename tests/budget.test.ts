// Monthly call budget (hard cap, fail closed), billing periods, and pinned-address TTLs.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  billingPeriodKey,
  BUDGET_KEY_TTL_SECONDS,
  CALLS_PER_REPORT,
  DEFAULT_CALL_BUDGET,
  INVALID_BUDGET_LOG,
  parseBillingDay,
  parseCallBudget,
} from "@/lib/budget";
import { MemoryCache, type ReportCache } from "@/lib/cache";
import { PINNED_ADDRESSES } from "@/lib/pinnedAddresses";
import { PINNED_CACHE_TTL_SECONDS, REPORT_CACHE_TTL_SECONDS, reportCacheKey } from "@/lib/property/handler";

import { addressRouter, LISTED_ADDRESS, SKIP_NO_FIXTURES, UNLISTED_ADDRESS } from "./helpers/fixtures";
import { callProperty, errorCode } from "./helpers/request";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
const NOV_10 = utc(2026, 11, 10);
const BILLING_MESSAGE = "The property data provider is unavailable for billing reasons.";

/** A distinct address per report; the fake Rentcast answers with Prentice Ln data. */
const nthAddress = (n: number) => `${100 + n} Budget Test Ln, Austin, TX 78746`;

/** In-memory store that records counter increments and can be told to fail. */
function counterStore(options: { shared?: boolean; incr?: "throw" | "hang" } = {}) {
  const inner = new MemoryCache();
  const incrs: { key: string; amount: number; ttl: number }[] = [];
  const sets: { key: string; ttl: number }[] = [];
  const store: ReportCache = {
    shared: options.shared ?? false,
    get: (key) => inner.get(key),
    set: async (key, value, ttl) => {
      sets.push({ key, ttl });
      await inner.set(key, value, ttl);
    },
    incrBy: async (key, amount, ttl) => {
      incrs.push({ key, amount, ttl });
      if (options.incr === "throw") throw new Error("counter down");
      if (options.incr === "hang") return new Promise<number>(() => {});
      return inner.incrBy(key, amount, ttl);
    },
  };
  const total = async (now = NOV_10, billingDay = 1) => Number((await inner.get(billingPeriodKey(now, billingDay))) ?? 0);
  return { store, incrs, sets, total };
}

describe("budget settings", () => {
  test("budget setting: positive integer, else 40 with one safe line", () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    assert.equal(parseCallBudget("48", log), 48);
    assert.equal(parseCallBudget(" 12 ", log), 12);
    assert.equal(parseCallBudget(undefined, log), DEFAULT_CALL_BUDGET);
    assert.equal(parseCallBudget("", log), 40);
    assert.deepEqual(logs, [], "blank is not an error");
    for (const bad of ["abc", "0", "-5", "4.5", "1e3"]) assert.equal(parseCallBudget(bad, log), 40);
    assert.equal(logs.length, 5);
    assert.ok(logs.every((l) => l === INVALID_BUDGET_LOG));
    assert.equal(INVALID_BUDGET_LOG.endsWith("using 40"), true);
  });

  test("BILLING_DAY: integer 1-28, else 1 with 'invalid BILLING_DAY'", () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    assert.equal(parseBillingDay("9", log), 9);
    assert.equal(parseBillingDay("28", log), 28);
    assert.equal(parseBillingDay("1", log), 1);
    for (const bad of ["0", "29", "31", "-1", "9.5", "nine", "", undefined]) assert.equal(parseBillingDay(bad, log), 1);
    assert.equal(logs.length, 8);
    assert.ok(logs.every((l) => l === "invalid BILLING_DAY"));
  });
});

describe("billing period key", () => {
  test("BILLING_DAY=9: Nov 8 and Nov 9 are different periods", () => {
    assert.equal(billingPeriodKey(utc(2026, 11, 8), 9), "budget:rentcast:2026-10");
    assert.equal(billingPeriodKey(utc(2026, 11, 9), 9), "budget:rentcast:2026-11");
  });
  test("BILLING_DAY=9: Dec 8 is still the Nov period; Dec 9 starts a new one", () => {
    assert.equal(billingPeriodKey(utc(2026, 12, 8), 9), "budget:rentcast:2026-11");
    assert.equal(billingPeriodKey(utc(2026, 12, 9), 9), "budget:rentcast:2026-12");
  });
  test("BILLING_DAY=9: Jan 3 belongs to the previous December's period", () => {
    assert.equal(billingPeriodKey(utc(2027, 1, 3), 9), "budget:rentcast:2026-12");
  });
  test("BILLING_DAY=1 behaves like a calendar month", () => {
    assert.equal(billingPeriodKey(utc(2026, 11, 1), 1), "budget:rentcast:2026-11");
    assert.equal(billingPeriodKey(utc(2026, 11, 30), 1), "budget:rentcast:2026-11");
    assert.equal(billingPeriodKey(utc(2026, 12, 1), 1), "budget:rentcast:2026-12");
    assert.equal(billingPeriodKey(utc(2027, 1, 1), 1), "budget:rentcast:2027-01");
  });
  test("uses UTC, not local time", () => {
    // 23:30 on Nov 8 in New York is already Nov 9 in UTC.
    assert.equal(billingPeriodKey(new Date("2026-11-09T04:30:00Z"), 9), "budget:rentcast:2026-11");
    assert.equal(billingPeriodKey(new Date("2026-11-09T00:00:00Z"), 9), "budget:rentcast:2026-11");
    assert.equal(billingPeriodKey(new Date("2026-11-08T23:59:59Z"), 9), "budget:rentcast:2026-10");
  });
});

describe("monthly call budget on /api/property", { skip: SKIP_NO_FIXTURES }, () => {
  const deps = (store: ReportCache, budget: number, now: Date = NOV_10, billingDay = 1) => ({
    cache: store,
    budget: { budget, billingDay },
    now: () => now,
  });

  test("worked example: budget 40 allows 10 uncached reports; the 11th gets 402, no fetch", async () => {
    const { store, incrs, total } = counterStore();
    for (let n = 1; n <= 10; n++) {
      const r = await callProperty(nthAddress(n), addressRouter(), { deps: deps(store, 40) });
      assert.equal(r.status, 200, `report ${n}`);
      assert.equal(r.calls.length, 4);
    }
    assert.equal(await total(), 40);
    const eleventh = await callProperty(nthAddress(11), addressRouter(), { deps: deps(store, 40) });
    assert.equal(eleventh.status, 402);
    assert.deepEqual(eleventh.body, { error: "upstream_billing", message: BILLING_MESSAGE });
    assert.deepEqual(eleventh.calls, []);
    assert.ok(eleventh.logs.includes("monthly call budget reached"));
    assert.ok(incrs.every((i) => i.amount === CALLS_PER_REPORT && i.ttl === BUDGET_KEY_TTL_SECONDS));
  });

  test("cache hits never touch the counter", async () => {
    const { store, incrs } = counterStore();
    await callProperty(LISTED_ADDRESS, addressRouter(), { deps: deps(store, 40) });
    const hit = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: deps(store, 40) });
    assert.equal(hit.headers.get("x-cache"), "HIT");
    assert.equal(incrs.length, 1);
  });

  test("cache hits are still served after the budget is used up", async () => {
    const { store } = counterStore();
    await callProperty(LISTED_ADDRESS, addressRouter(), { deps: deps(store, 4) });
    assert.equal((await callProperty(UNLISTED_ADDRESS, addressRouter(), { deps: deps(store, 4) })).status, 402);
    const hit = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: deps(store, 4) });
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-cache"), "HIT");
  });

  test("a failed upstream request is still counted (no refund)", async () => {
    const { store, total } = counterStore();
    const r = await callProperty(LISTED_ADDRESS, addressRouter({ "/avm/value": { status: 503, body: {} } }), { deps: deps(store, 40) });
    assert.equal(r.status, 502);
    assert.equal(await total(), 4);
  });

  test("a new billing period starts fresh", async () => {
    const { store } = counterStore();
    const nov10 = await callProperty(nthAddress(1), addressRouter(), { deps: deps(store, 4, utc(2026, 11, 10), 9) });
    assert.equal(nov10.status, 200);
    const dec8 = await callProperty(nthAddress(2), addressRouter(), { deps: deps(store, 4, utc(2026, 12, 8), 9) });
    assert.equal(dec8.status, 402, "Dec 8 is still the Nov 9 period");
    const dec9 = await callProperty(nthAddress(3), addressRouter(), { deps: deps(store, 4, utc(2026, 12, 9), 9) });
    assert.equal(dec9.status, 200, "Dec 9 starts a new period");
  });

  test("a throwing counter store fails CLOSED: 402, no fetch", async () => {
    const { store } = counterStore({ incr: "throw" });
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: deps(store, 40) });
    assert.equal(r.status, 402);
    assert.equal(errorCode(r), "upstream_billing");
    assert.deepEqual(r.calls, []);
    assert.ok(r.logs.includes("budget check failed"));
    assert.ok(!r.logs.some((l) => l.includes("counter down")));
  });

  test("a hanging counter store times out (1.5s) and fails CLOSED", async () => {
    const { store } = counterStore({ incr: "hang" });
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: deps(store, 40) });
    assert.equal(r.status, 402);
    assert.deepEqual(r.calls, []);
    assert.ok(r.logs.includes("budget check failed"));
  });

  test("production without a shared counter fails CLOSED", async () => {
    const { store, incrs } = counterStore({ shared: false });
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { ...deps(store, 40), requireSharedCounter: true } });
    assert.equal(r.status, 402);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(incrs, []);
    assert.ok(r.logs.includes("budget check failed: no shared counter"));

    const shared = counterStore({ shared: true });
    const ok = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { ...deps(shared.store, 40), requireSharedCounter: true } });
    assert.equal(ok.status, 200);
  });

  test("never runs for a request that failed the gate or validation", async () => {
    const { store, incrs } = counterStore();
    const gated = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { ...deps(store, 40), demoKey: "gate-on-value" } });
    assert.equal(gated.status, 401);
    const invalid = await callProperty("ab", addressRouter(), { deps: deps(store, 40) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(incrs, []);
  });
});

describe("pinned sample addresses", { skip: SKIP_NO_FIXTURES }, () => {
  test("the list is exactly the two app sample addresses", () => {
    assert.deepEqual(PINNED_ADDRESSES, ["3901 Prentice Ln, Austin, TX 78746", "3712 Meredith St, Austin, TX 78703"]);
    assert.equal(PINNED_CACHE_TTL_SECONDS, 30 * 86_400);
  });

  test("pinned -> 30-day TTL; non-pinned -> 24h", async () => {
    const { store, sets } = counterStore();
    await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { cache: store } });
    await callProperty(nthAddress(1), addressRouter(), { deps: { cache: store } });
    assert.deepEqual(sets, [
      { key: reportCacheKey(LISTED_ADDRESS), ttl: PINNED_CACHE_TTL_SECONDS },
      { key: reportCacheKey(nthAddress(1)), ttl: REPORT_CACHE_TTL_SECONDS },
    ]);
  });

  test("a differently spelled pinned address is still pinned", async () => {
    const { store, sets } = counterStore();
    await callProperty("3712  meredith street austin texas 78703", addressRouter(), { deps: { cache: store } });
    assert.equal(sets[0].ttl, PINNED_CACHE_TTL_SECONDS);
  });
});
