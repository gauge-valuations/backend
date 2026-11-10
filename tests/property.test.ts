// Offline tests for GET /api/property: a fake fetch serves the raw Rentcast captures.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toHttpError } from "@/lib/errors";
import { stripNulls } from "@/lib/normalize/nulls";
import { handlePropertyRequest, type HandlerDeps } from "@/lib/property/handler";
import { RentcastError } from "@/lib/rentcast/client";
import type { RentcastRentEstimate, RentcastSubjectProperty, RentcastValueEstimate } from "@/lib/rentcast/responses";
import { parsePropertyReport, type PropertyReport } from "@/lib/types";
import { computeValuation } from "@/lib/valuation";

import {
  addressRouter,
  fakeFetch,
  findNulls,
  fixtureBody,
  hangingFetch,
  LISTED_ADDRESS,
  loadFixture,
  SENTINEL_KEY,
  SKIP_NO_FIXTURES,
  UNLISTED_ADDRESS,
  type Router,
} from "./helpers/fixtures";

type Result = { status: number; body: unknown; text: string; logs: string[]; calls: string[] };

async function call(address: string | null, router: Router, extra: Partial<HandlerDeps> = {}): Promise<Result> {
  const logs: string[] = [];
  const fetch = fakeFetch(router);
  const url = new URL("http://localhost/api/property");
  if (address !== null) url.searchParams.set("address", address);
  const res = await handlePropertyRequest(new Request(url), {
    fetch,
    apiKey: SENTINEL_KEY,
    log: (line) => logs.push(line),
    ...extra,
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text, logs, calls: fetch.calls };
}

function assertNoLeaks(r: Result) {
  const everything = r.text + "\n" + r.logs.join("\n");
  assert.ok(!everything.includes(SENTINEL_KEY), "key leaked");
  assert.ok(!/could not be parsed|subscription|api dashboard/i.test(r.text), "upstream message leaked");
}

describe("GET /api/property (offline)", { skip: SKIP_NO_FIXTURES }, () => {
  test("Prentice Ln: full PropertyReport", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter());
    assert.equal(r.status, 200);
    const report = parsePropertyReport(r.body);
    assert.deepEqual(findNulls(r.body), []);
    assertNoLeaks(r);

    const value = fixtureBody<RentcastValueEstimate>("02-avm-value-listed");
    const rent = fixtureBody<RentcastRentEstimate>("03-avm-rent-listed");

    // Property comes from the AVM subject; Texas lastSalePrice is null -> omitted.
    assert.equal(report.property.address, LISTED_ADDRESS);
    assert.equal(report.property.sqft, 3820);
    assert.ok(!("lastSalePrice" in report.property));
    assert.equal(report.property.lastSaleDate, "1992-03-18T00:00:00.000Z");

    // Valuation: engine number (matches the swap point), Active list price, no margin.
    const expected = computeValuation({
      subject: stripNulls(value.subjectProperty) as RentcastSubjectProperty,
      valueEstimate: stripNulls(value) as RentcastValueEstimate,
      rentEstimate: stripNulls(rent) as RentcastRentEstimate,
    });
    assert.equal(report.valuation.estimatedValue, expected.valuation.estimatedValue);
    assert.equal(report.valuation.listPrice, 2195000);
    assert.ok(!("potentialMargin" in report.valuation));
    assert.equal(report.rent.monthlyRent, expected.monthlyRent);

    // Comps: Active only, "for_sale", correlation order preserved.
    const activeAddresses = (value.comparables ?? [])
      .filter((c) => c.status === "Active")
      .map((c) => c.formattedAddress);
    assert.deepEqual(report.comps.map((c) => c.address), activeAddresses);
    assert.ok(report.comps.every((c) => c.status === "for_sale"));
    assert.equal(report.comps.length, 11);

    // Rent comps: all 15, all "for_lease", in order.
    assert.equal(report.rent.rentComps.length, 15);
    assert.ok(report.rent.rentComps.every((c) => c.status === "for_lease"));
    assert.deepEqual(report.rent.rentComps.map((c) => c.address), (rent.comparables ?? []).map((c) => c.formattedAddress));

    // Market zip comes from the AVM subject.
    assert.equal(report.market.zip, "78746");
    assert.deepEqual(r.calls.sort(), ["/avm/rent/long-term", "/avm/value", "/listings/sale", "/markets"]);
  });

  test("Meredith St: Inactive listing gives no listPrice", async () => {
    const r = await call(UNLISTED_ADDRESS, addressRouter());
    assert.equal(r.status, 200);
    const report: PropertyReport = parsePropertyReport(r.body);
    assert.deepEqual(findNulls(r.body), []);
    assert.equal(report.property.address, UNLISTED_ADDRESS);
    assert.ok(!("listPrice" in report.valuation));
    assert.ok(!("potentialMargin" in report.valuation));
    assertNoLeaks(r);
  });

  test("404 from /listings/sale means no listing, still 200", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/listings/sale": { status: 404, body: {} } }));
    assert.equal(r.status, 200);
    assert.ok(!("listPrice" in parsePropertyReport(r.body).valuation));
  });

  test("404 from /avm/value -> 404", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": { status: 404, body: {} } }));
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "not_found", message: "No property data was found for this address." });
  });

  test("bad address fixture (08, HTTP 400) -> 400 invalid_address", async () => {
    const r = await call("asdfgh", addressRouter({ "/avm/value": loadFixture("08-avm-value-bad") }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, "invalid_address");
    assertNoLeaks(r);
  });

  test("subscription fixture (00, HTTP 403 billing) -> 402", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": loadFixture("00-error-subscription-inactive") }));
    assert.equal(r.status, 402);
    assert.equal((r.body as { error: string }).error, "upstream_billing");
    assertNoLeaks(r);
    assert.ok(r.logs.some((l) => l.includes("billing/subscription-inactive")));
  });

  test("timeout -> 502 upstream_unavailable", async () => {
    const logs: string[] = [];
    const url = new URL("http://localhost/api/property");
    url.searchParams.set("address", LISTED_ADDRESS);
    const res = await handlePropertyRequest(new Request(url), {
      fetch: hangingFetch(),
      apiKey: SENTINEL_KEY,
      deadlineMs: 50,
      log: (line) => logs.push(line),
    });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, "upstream_unavailable");
    assert.ok(logs.some((l) => l.includes("timeout")));
  });

  test("network error -> 502", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/rent/long-term": new TypeError("fetch failed") }));
    assert.equal(r.status, 502);
    assertNoLeaks(r);
  });

  test("subject missing required fields -> 502 upstream_incomplete", async () => {
    const value = fixtureBody<RentcastValueEstimate>("02-avm-value-listed");
    const broken = { ...value, subjectProperty: { ...value.subjectProperty, lotSize: undefined } };
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": { status: 200, body: broken } }));
    assert.equal(r.status, 502);
    assert.equal((r.body as { error: string }).error, "upstream_incomplete");
  });
});

describe("address validation", () => {
  for (const [label, address] of [
    ["missing", null],
    ["blank", "   "],
    ["too short", "ab"],
    ["too long", "x".repeat(201)],
    ["control chars", "1 Main St\n, Austin, TX"],
  ] as const) {
    test(`${label} -> 400 without any upstream call`, async () => {
      const r = await call(address, () => new Error("should not be called"));
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, "invalid_address");
      assert.deepEqual(r.calls, []);
    });
  }
});

describe("error mapping", () => {
  const map = (status: number, code?: string) => toHttpError(new RentcastError("/avm/value", "http", status, code)).status;
  test("code first, then status", () => {
    assert.equal(map(400, "resource/bad-request"), 400);
    assert.equal(map(403, "billing/subscription-inactive"), 402);
    assert.equal(map(402, "billing/quota-exceeded"), 402);
    assert.equal(map(404), 404);
    assert.equal(map(429), 502);
    assert.equal(map(401, "auth/api-key-invalid"), 500);
    assert.equal(map(403, "auth/forbidden"), 500);
    assert.equal(map(500), 502);
    assert.equal(map(504), 502);
    assert.equal(map(418), 500);
  });
  test("non-HTTP failures", () => {
    assert.equal(toHttpError(new RentcastError("/x", "timeout")).status, 502);
    assert.equal(toHttpError(new RentcastError("/x", "network")).status, 502);
    assert.equal(toHttpError(new RentcastError("/x", "config")).status, 500);
    assert.equal(toHttpError(new Error("boom")).status, 500);
  });
});

describe("stripNulls", () => {
  test("drops null keys and null array items, recursively", () => {
    assert.deepEqual(stripNulls({ a: 1, b: null, c: { d: null, e: [1, null, { f: null }] } }), {
      a: 1,
      c: { e: [1, {}] },
    });
  });
});
