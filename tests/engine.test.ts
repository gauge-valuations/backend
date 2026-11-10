// Valuation engine tests: tiny hand-checkable cases, then the real fixtures.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { handlePropertyRequest } from "@/lib/property/handler";
import type { RentcastRentEstimate, RentcastValueEstimate } from "@/lib/rentcast/responses";
import { parsePropertyReport } from "@/lib/types";
import {
  estimateRent,
  estimateValue,
  pricePerSqft,
  quantile,
  removeOutliers,
  weightedMedian,
  weightedPercentile,
  type EngineComp,
} from "@/lib/valuation/engine";

import {
  addressRouter,
  fakeFetch,
  findNulls,
  fixtureBody,
  LISTED_ADDRESS,
  SENTINEL_KEY,
  SKIP_NO_FIXTURES,
} from "./helpers/fixtures";

/** A 1,000 sqft comp priced at `perSqft` $/sqft with correlation `weight`. */
const comp = (perSqft: number, weight: number): EngineComp => ({
  price: perSqft * 1000,
  squareFootage: 1000,
  correlation: weight,
});

const FALLBACK = { value: 999_999, low: 900_000, high: 1_100_000 };

describe("engine: hand-computed cases", () => {
  test("pricePerSqft skips missing, zero, and negative inputs", () => {
    assert.equal(pricePerSqft({ price: 300_000, squareFootage: 1500 }), 200); // 300,000 / 1,500
    assert.equal(pricePerSqft({ price: 300_000, squareFootage: 0 }), undefined);
    assert.equal(pricePerSqft({ price: 300_000, squareFootage: -5 }), undefined);
    assert.equal(pricePerSqft({ price: 0, squareFootage: 1000 }), undefined);
    assert.equal(pricePerSqft({ squareFootage: 1000 }), undefined);
  });

  // $/sqft 100,200,300,400,500 with weights .1,.2,.3,.2,.2 (total 1.0)
  // cumulative weights: 100->.1, 200->.3, 300->.6, 400->.8, 500->1.0
  const five = [
    { value: 100, weight: 0.1 },
    { value: 200, weight: 0.2 },
    { value: 300, weight: 0.3 },
    { value: 400, weight: 0.2 },
    { value: 500, weight: 0.2 },
  ];

  test("weighted median: first value where cumulative weight >= half", () => {
    // half of 1.0 = .5; .1, .3, .6 -> 300
    assert.equal(weightedMedian(five), 300);
  });

  test("weighted 25th / 75th percentile use the same rule", () => {
    // .25 target: .1, .3 -> 200.   .75 target: .1, .3, .6, .8 -> 400
    assert.equal(weightedPercentile(five, 0.25), 200);
    assert.equal(weightedPercentile(five, 0.75), 400);
    // input order does not matter (sorted internally)
    assert.equal(weightedMedian([...five].reverse()), 300);
  });

  test("ties and exact halves return the lower value", () => {
    // 100(w .5), 100(w .5), 200(w 1): total 2, half 1; cumulative .5, 1.0 -> 100
    assert.equal(weightedMedian([{ value: 200, weight: 1 }, { value: 100, weight: 0.5 }, { value: 100, weight: 0.5 }]), 100);
    // floating point: .1 + .2 + .2 = 0.5000000000000001-ish; still lands on 300 for p=.5 of 1.0
    assert.equal(weightedMedian([{ value: 100, weight: 0.1 }, { value: 200, weight: 0.2 }, { value: 300, weight: 0.2 }, { value: 400, weight: 0.5 }]), 300);
  });

  test("estimateValue on the five comps", () => {
    const result = estimateValue([comp(100, 0.1), comp(200, 0.2), comp(300, 0.3), comp(400, 0.2), comp(500, 0.2)], 2000, FALLBACK);
    // IQR (type 7): Q1 = 200, Q3 = 400, IQR = 200 -> fences -100..700, nothing dropped
    // median 300 $/sqft x 2,000 sqft = 600,000; range 200 x 2,000 = 400,000 .. 400 x 2,000 = 800,000
    assert.deepEqual(result, {
      value: 600_000,
      valueLow: 400_000,
      valueHigh: 800_000,
      pricePerSqft: 300,
      usableComps: 5,
      droppedComps: 0,
      source: "engine",
      lowConfidence: false,
    });
  });

  test("a zero-sqft comp is skipped, not counted", () => {
    const comps = [comp(100, 1), comp(200, 1), comp(300, 1), comp(400, 1), { price: 500_000, squareFootage: 0, correlation: 1 }];
    const result = estimateValue(comps, 1000, FALLBACK);
    // 4 usable (no IQR filter below 5). equal weights, total 4, half 2: cumulative 1, 2 -> 200
    assert.equal(result.usableComps, 4);
    assert.equal(result.droppedComps, 1);
    assert.equal(result.value, 200_000); // 200 x 1,000
  });

  test("an IQR outlier is dropped once there are 5+ comps", () => {
    // $/sqft 100,110,120,130,140,1000
    // Q1 at pos 1.25 = 110 + .25*10 = 112.5; Q3 at pos 3.75 = 130 + .75*10 = 137.5
    // IQR 25 -> fences 112.5 - 37.5 = 75 .. 137.5 + 37.5 = 175 -> 1000 dropped
    assert.equal(quantile([100, 110, 120, 130, 140, 1000], 0.25), 112.5);
    assert.equal(quantile([100, 110, 120, 130, 140, 1000], 0.75), 137.5);
    const comps = [100, 110, 120, 130, 140, 1000].map((v) => comp(v, 1));
    const result = estimateValue(comps, 1000, FALLBACK);
    // remaining 5 equal weights, half 2.5: cumulative 1, 2, 3 -> 120
    assert.equal(result.usableComps, 5);
    assert.equal(result.droppedComps, 1);
    assert.equal(result.value, 120_000);
  });

  test("below 5 comps the outlier is kept", () => {
    const points = [100, 110, 120, 1000].map((value) => ({ value, weight: 1 }));
    assert.equal(removeOutliers(points).length, 4);
    // total 4, half 2: cumulative 1, 2 -> 110
    assert.equal(estimateValue([100, 110, 120, 1000].map((v) => comp(v, 1)), 1000, FALLBACK).value, 110_000);
  });

  test("exactly 2 usable comps -> Rentcast fallback, low confidence", () => {
    const result = estimateValue([comp(100, 1), comp(200, 1), { price: 5, correlation: 1 }], 2000, FALLBACK);
    assert.deepEqual(result, {
      value: 999_999,
      valueLow: 900_000,
      valueHigh: 1_100_000,
      pricePerSqft: 500, // 999,999 / 2,000 = 499.9995 -> 500.00
      usableComps: 2,
      droppedComps: 1,
      source: "rentcast_fallback",
      lowConfidence: true,
    });
  });

  test("rent uses the same procedure", () => {
    // rent $/sqft 1, 2, 3 with equal weights -> median 2; x 1,500 sqft = 3,000/month
    const comps = [1, 2, 3].map((perSqft) => ({ price: perSqft * 1000, squareFootage: 1000, correlation: 0.9 }));
    const result = estimateRent(comps, 1500, { value: 2_500 });
    assert.equal(result.rent, 3000);
    assert.equal(result.rentPerSqft, 2);
    assert.equal(result.source, "engine");
  });

  test("rounding happens once, at the end", () => {
    // $/sqft 100.4 each; x 1,001 sqft = 100,500.4 -> 100,500 (not 100 x 1,001 = 100,100)
    const comps = [1, 2, 3].map(() => ({ price: 100_400, squareFootage: 1000, correlation: 1 }));
    assert.equal(estimateValue(comps, 1001, FALLBACK).value, 100_500);
  });
});

describe("engine vs Rentcast on captured fixtures", { skip: SKIP_NO_FIXTURES }, () => {
  const pct = (engine: number, rentcast: number) => ((engine - rentcast) / rentcast) * 100;
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

  test("comparison table (reported, not tuned)", () => {
    const rows: string[] = [];
    const add = (label: string, engine: number, rentcast: number, range: string, extra: string) => {
      const diff = pct(engine, rentcast);
      const flag = Math.abs(diff) > 15 ? "  <-- >15%" : "";
      rows.push(`${label.padEnd(26)} ${usd(engine).padStart(12)} ${usd(rentcast).padStart(12)} ${range.padStart(25)} ${(diff.toFixed(1) + "%").padStart(7)}  ${extra}${flag}`);
    };

    for (const [label, name] of [
      ["Value: 3901 Prentice Ln", "02-avm-value-listed"],
      ["Value: 3712 Meredith St", "06-avm-value-unlisted"],
    ] as const) {
      const avm = fixtureBody<RentcastValueEstimate>(name);
      const r = estimateValue(avm.comparables ?? [], avm.subjectProperty?.squareFootage, { value: avm.price ?? 0 });
      add(label, r.value, avm.price ?? 0, `${usd(avm.priceRangeLow ?? 0)}-${usd(avm.priceRangeHigh ?? 0)}`,
        `engine ${usd(r.valueLow)}-${usd(r.valueHigh)}, $${r.pricePerSqft}/sqft, ${r.usableComps} used, ${r.droppedComps} dropped, ${r.source}`);
      assert.ok(r.value > 0);
    }

    const rentAvm = fixtureBody<RentcastRentEstimate>("03-avm-rent-listed");
    const rr = estimateRent(rentAvm.comparables ?? [], rentAvm.subjectProperty?.squareFootage, { value: rentAvm.rent ?? 0 });
    add("Rent: 3901 Prentice Ln", rr.rent, rentAvm.rent ?? 0, `${usd(rentAvm.rentRangeLow ?? 0)}-${usd(rentAvm.rentRangeHigh ?? 0)}`,
      `engine ${usd(rr.rentLow)}-${usd(rr.rentHigh)}, $${rr.rentPerSqft}/sqft, ${rr.usableComps} used, ${rr.droppedComps} dropped, ${rr.source}`);
    assert.ok(rr.rent > 0);

    console.log(
      [
        "",
        `${"".padEnd(26)} ${"engine".padStart(12)} ${"rentcast".padStart(12)} ${"rentcast range".padStart(25)} ${"diff".padStart(7)}`,
        ...rows,
        "",
      ].join("\n"),
    );
  });

  test("Prentice Ln report passes parsePropertyReport with the engine wired in", async () => {
    const url = new URL("http://localhost/api/property");
    url.searchParams.set("address", LISTED_ADDRESS);
    const res = await handlePropertyRequest(new Request(url), {
      fetch: fakeFetch(addressRouter()),
      apiKey: SENTINEL_KEY,
      log: () => {},
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const report = parsePropertyReport(body);
    assert.deepEqual(findNulls(body), []);
    const avm = fixtureBody<RentcastValueEstimate>("02-avm-value-listed");
    const expected = estimateValue(avm.comparables ?? [], 3820, { value: avm.price ?? 0 });
    assert.equal(report.valuation.estimatedValue, expected.value);
  });
});
