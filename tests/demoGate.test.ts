// Demo gate: X-Demo-Key must match when the gate is on; never leaks the value.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MemoryCache, type ReportCache } from "@/lib/cache";
import { demoKeyMatches } from "@/lib/demoGate";

import { addressRouter, LISTED_ADDRESS, SKIP_NO_FIXTURES } from "./helpers/fixtures";
import { callProperty, errorCode, type CallResult } from "./helpers/request";

const DEMO_SENTINEL = "demo-sentinel-value-4b7e2a";
const UNAUTHORIZED = { error: "unauthorized", message: "This request is not authorized." };

function assertNoDemoLeak(r: CallResult) {
  assert.ok(!r.text.includes(DEMO_SENTINEL), "demo key in body");
  assert.ok(!r.logs.some((l) => l.includes(DEMO_SENTINEL)), "demo key in logs");
  assert.ok(!r.text.includes("wrong-value"), "provided header echoed");
}

/** A cache that records every touch. */
function spyCache(): ReportCache & { touches: number } {
  const inner = new MemoryCache();
  const spy = {
    shared: false,
    touches: 0,
    async get(key: string) {
      spy.touches++;
      return inner.get(key);
    },
    async set(key: string, value: string, ttl: number) {
      spy.touches++;
      return inner.set(key, value, ttl);
    },
    async incrBy(key: string, amount: number, ttl: number) {
      spy.touches++;
      return inner.incrBy(key, amount, ttl);
    },
  };
  return spy;
}

describe("demoKeyMatches", () => {
  test("exact match only; length mismatch handled", () => {
    assert.equal(demoKeyMatches(DEMO_SENTINEL, DEMO_SENTINEL), true);
    assert.equal(demoKeyMatches(DEMO_SENTINEL + "x", DEMO_SENTINEL), false);
    assert.equal(demoKeyMatches("short", DEMO_SENTINEL), false);
    assert.equal(demoKeyMatches("", DEMO_SENTINEL), false);
    assert.equal(demoKeyMatches(null, DEMO_SENTINEL), false);
  });
});

describe("demo gate on /api/property", { skip: SKIP_NO_FIXTURES }, () => {
  const gateOn = { demoKey: DEMO_SENTINEL };

  test("no header -> 401, zero fetch calls, cache untouched", async () => {
    const cache = spyCache();
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { ...gateOn, cache } });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, UNAUTHORIZED);
    assert.deepEqual(r.calls, []);
    assert.equal(cache.touches, 0);
    assert.deepEqual(r.logs, ["property unauthorized"]);
    assertNoDemoLeak(r);
  });

  test("wrong header -> 401 (same and different length)", async () => {
    for (const wrong of ["wrong-value", "x".repeat(DEMO_SENTINEL.length)]) {
      const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: gateOn, headers: { "X-Demo-Key": wrong } });
      assert.equal(r.status, 401);
      assert.equal(errorCode(r), "unauthorized");
      assert.deepEqual(r.calls, []);
      assertNoDemoLeak(r);
    }
  });

  test("gate runs before address validation", async () => {
    const r = await callProperty("ab", addressRouter(), { deps: gateOn });
    assert.equal(r.status, 401);
  });

  test("right header -> 200", async () => {
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: gateOn, headers: { "x-demo-key": DEMO_SENTINEL } });
    assert.equal(r.status, 200);
    assert.equal(r.calls.length, 4);
    assertNoDemoLeak(r);
  });

  test("gate off -> 200 without any header", async () => {
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { deps: { demoKey: null } });
    assert.equal(r.status, 200);
  });
});
