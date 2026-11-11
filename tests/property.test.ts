// Offline tests for GET /api/property: a fake fetch serves the raw Rentcast captures.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { displayAddress } from "@/lib/displayAddress";
import { toHttpError } from "@/lib/errors";
import { stripNulls } from "@/lib/normalize/nulls";
import { RentcastError } from "@/lib/rentcast/client";
import type {
  RentcastComparable,
  RentcastRentEstimate,
  RentcastSubjectProperty,
  RentcastValueEstimate,
} from "@/lib/rentcast/responses";
import { parsePropertyReport, type PropertyReport } from "@/lib/types";
import { computeValuation } from "@/lib/valuation";

import {
  addressRouter,
  findNulls,
  fixtureBody,
  hangingFetch,
  LISTED_ADDRESS,
  loadFixture,
  SENTINEL_KEY,
  SKIP_NO_FIXTURES,
  UNLISTED_ADDRESS,
} from "./helpers/fixtures";
import { callProperty as call, errorCode, type CallResult } from "./helpers/request";

function assertNoLeaks(r: CallResult) {
  const everything = r.text + "\n" + r.logs.join("\n");
  assert.ok(!everything.includes(SENTINEL_KEY), "key leaked");
  assert.ok(!/could not be parsed|subscription|api dashboard/i.test(r.text), "upstream message leaked");
}

/** The Prentice Ln value AVM with its subject modified. */
function prenticeWithSubject(patch: Partial<Record<keyof RentcastSubjectProperty, undefined>>) {
  const value = fixtureBody<RentcastValueEstimate>("02-avm-value-listed");
  return { status: 200, body: { ...value, subjectProperty: { ...value.subjectProperty, ...patch } } };
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
    assert.equal(report.property.yearBuilt, value.subjectProperty?.yearBuilt);
    assert.equal(report.property.lotSizeSqft, value.subjectProperty?.lotSize);
    assert.ok(!("lastSalePrice" in report.property));
    assert.equal(report.property.lastSaleDate, "1992-03-18T00:00:00.000Z");

    // Valuation and rent figures come from the engine via the swap point.
    const expected = computeValuation({
      subject: stripNulls(value.subjectProperty) as RentcastSubjectProperty,
      valueEstimate: stripNulls(value) as RentcastValueEstimate,
      rentEstimate: stripNulls(rent) as RentcastRentEstimate,
    });
    assert.deepEqual(report.valuation, { ...expected.valuation, listPrice: 2195000 });
    assert.equal(report.valuation.pricePerSqft, expected.internal.value.pricePerSqft);
    assert.equal(report.valuation.valueRangeLow, expected.internal.value.valueLow);
    assert.equal(report.valuation.valueRangeHigh, expected.internal.value.valueHigh);
    assert.ok(!("lowConfidence" in report.valuation), "lowConfidence only when true");
    assert.ok(!("potentialMargin" in report.valuation));
    assert.equal(report.rent.monthlyRent, expected.rent.monthlyRent);
    assert.equal(report.rent.rentPerSqft, expected.internal.rent.rentPerSqft);
    assert.equal(report.rent.rentRangeLow, expected.internal.rent.rentLow);
    assert.equal(report.rent.rentRangeHigh, expected.internal.rent.rentHigh);

    // Comps: ALL 15, correlation order, Active -> for_sale, Inactive -> off_market.
    const comparables = value.comparables ?? [];
    assert.equal(report.comps.length, 15);
    assert.deepEqual(report.comps.map((c) => c.address), comparables.map((c) => displayAddress(c)));
    assert.deepEqual(
      report.comps.map((c) => c.status),
      comparables.map((c) => (c.status === "Active" ? "for_sale" : "off_market")),
    );
    assert.equal(report.comps.filter((c) => c.status === "for_sale").length, 11);
    assert.equal(report.comps.filter((c) => c.status === "off_market").length, 4);
    assert.ok(!report.comps.some((c) => c.status === "sold"));

    // Rent comps: all 15, all "for_lease", in order.
    assert.equal(report.rent.rentComps.length, 15);
    assert.ok(report.rent.rentComps.every((c) => c.status === "for_lease"));
    assert.deepEqual(report.rent.rentComps.map((c) => c.address), (rent.comparables ?? []).map((c) => displayAddress(c)));

    // Street names Rentcast split across two lines come back whole, and every comp
    // address is "street, City, ST 12345" with no comma inside the street.
    const saleAddresses = report.comps.map((c) => c.address);
    assert.ok(saleAddresses.includes("2004 Rue De St Tropez, Austin, TX 78746"));
    assert.ok(saleAddresses.includes("2305 Trail of the Madrones, Austin, TX 78746"));
    const rentAddresses = report.rent.rentComps.map((c) => c.address);
    assert.ok(rentAddresses.includes("2007 Rue De St Tropez, Austin, TX 78746"));
    assert.ok(rentAddresses.includes("2100 Rue De St Germaine, Austin, TX 78746"));
    for (const address of [...saleAddresses, ...rentAddresses]) {
      assert.match(address, /^[^,]+, [^,]+, [A-Z]{2} \d{5}$/, address);
    }

    // Market zip comes from the AVM subject.
    assert.equal(report.market.zip, "78746");
    assert.deepEqual(r.calls.sort(), ["/avm/rent/long-term", "/avm/value", "/listings/sale", "/markets"]);
  });

  test("every comp pricePerSqft = round(price / sqft): dollars for sale, cents for rent", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter());
    const report = parsePropertyReport(r.body);
    for (const c of report.comps) {
      assert.equal(c.pricePerSqft, Math.round(c.price / c.sqft), c.address);
      assert.ok(Number.isInteger(c.pricePerSqft));
    }
    for (const c of report.rent.rentComps) {
      assert.equal(c.pricePerSqft, Math.round((c.price / c.sqft) * 100) / 100, c.address);
    }
  });

  test("a comp with zero sqft gets no pricePerSqft key (never 0 or NaN)", async () => {
    const value = fixtureBody<RentcastValueEstimate>("02-avm-value-listed");
    const comparables = (value.comparables ?? []).map((c, i): RentcastComparable => (i === 0 ? { ...c, squareFootage: 0 } : c));
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": { status: 200, body: { ...value, comparables } } }));
    const report = parsePropertyReport(r.body);
    assert.ok(!("pricePerSqft" in report.comps[0]));
    assert.ok(report.comps.slice(1).every((c) => typeof c.pricePerSqft === "number"));
  });

  test("Meredith St: Inactive listing gives no listPrice", async () => {
    const r = await call(UNLISTED_ADDRESS, addressRouter());
    assert.equal(r.status, 200);
    const report: PropertyReport = parsePropertyReport(r.body);
    assert.deepEqual(findNulls(r.body), []);
    assert.equal(report.property.address, UNLISTED_ADDRESS);
    assert.ok(!("listPrice" in report.valuation));
    assert.ok(!("potentialMargin" in report.valuation));
    assert.equal(typeof report.valuation.pricePerSqft, "number");
    assertNoLeaks(r);
  });

  test("missing yearBuilt and lotSize -> 200 with those keys absent", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": prenticeWithSubject({ yearBuilt: undefined, lotSize: undefined }) }));
    assert.equal(r.status, 200);
    const report = parsePropertyReport(r.body);
    assert.ok(!("yearBuilt" in report.property));
    assert.ok(!("lotSizeSqft" in report.property));
    assert.deepEqual(findNulls(r.body), []);
  });

  test("subject missing sqft -> 502 upstream_incomplete", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": prenticeWithSubject({ squareFootage: undefined }) }));
    assert.equal(r.status, 502);
    assert.equal(errorCode(r), "upstream_incomplete");
  });

  test("too few comps -> lowConfidence: true with Rentcast's numbers", async () => {
    const value = fixtureBody<RentcastValueEstimate>("02-avm-value-listed");
    const few = { ...value, comparables: (value.comparables ?? []).slice(0, 2) };
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": { status: 200, body: few } }));
    const report = parsePropertyReport(r.body);
    assert.equal(report.valuation.lowConfidence, true);
    assert.equal(report.valuation.estimatedValue, value.price);
    assert.equal(report.valuation.valueRangeLow, value.priceRangeLow);
    assert.equal(report.valuation.valueRangeHigh, value.priceRangeHigh);
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
    assert.equal(errorCode(r), "invalid_address");
    assertNoLeaks(r);
  });

  test("subscription fixture (00, HTTP 403 billing) -> 402", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/value": loadFixture("00-error-subscription-inactive") }));
    assert.equal(r.status, 402);
    assert.equal(errorCode(r), "upstream_billing");
    assertNoLeaks(r);
    assert.ok(r.logs.some((l) => l.includes("billing/subscription-inactive")));
  });

  test("timeout -> 502 upstream_unavailable", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter(), { deps: { fetch: hangingFetch(), deadlineMs: 50 } });
    assert.equal(r.status, 502);
    assert.equal(errorCode(r), "upstream_unavailable");
    assert.ok(r.logs.some((l) => l.includes("timeout")));
  });

  test("network error -> 502", async () => {
    const r = await call(LISTED_ADDRESS, addressRouter({ "/avm/rent/long-term": new TypeError("fetch failed") }));
    assert.equal(r.status, 502);
    assertNoLeaks(r);
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
      assert.equal(errorCode(r), "invalid_address");
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
    assert.equal(map(401, "auth/api-key-invalid"), 500); // upstream 401 stays 500, not "unauthorized"
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
