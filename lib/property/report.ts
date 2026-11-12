// Builds a PropertyReport for one address from four Rentcast calls.

import { displayAddress } from "@/lib/displayAddress";
import { IncompleteDataError, type IncompleteField } from "@/lib/errors";
import { createRentcastClient, RentcastError, type FetchLike } from "@/lib/rentcast/client";
import type {
  RentcastComparable,
  RentcastMarketStats,
  RentcastRentEstimate,
  RentcastSaleListing,
  RentcastSubjectProperty,
  RentcastValueEstimate,
} from "@/lib/rentcast/responses";
import type { Comp, MarketSnapshot, Property, PropertyReport } from "@/lib/types";
import { computeValuation } from "@/lib/valuation";
import { pricePerSqft } from "@/lib/valuation/engine";

/**
 * One deadline shared by every Rentcast call in a request. Kept under the route's
 * maxDuration (15s) and the mobile app's 15s timeout so the app gets a clean 502.
 */
export const DEFAULT_DEADLINE_MS = 12_000;

export type ReportDeps = {
  fetch?: FetchLike;
  apiKey?: string;
  deadlineMs?: number;
};

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Address, beds, baths and sqft are required (missing -> 422 incomplete_data naming
 * them; nothing is guessed or defaulted).
 * Year built and lot size are optional: condo and land records often lack them,
 * so they are omitted rather than failing the request.
 */
function toProperty(subject: RentcastSubjectProperty | undefined): Property {
  const s = subject ?? {};
  const required = {
    address: s.formattedAddress,
    beds: s.bedrooms,
    baths: s.bathrooms,
    sqft: s.squareFootage,
  };
  const missing = (Object.keys(required) as (keyof typeof required)[]).filter((key) => {
    const v = required[key];
    return key === "address" ? typeof v !== "string" || v === "" : !isNum(v);
  });
  if (missing.length > 0) throw new IncompleteDataError(missing satisfies IncompleteField[]);

  const property: Property = {
    address: displayAddress(s),
    beds: s.bedrooms as number,
    baths: s.bathrooms as number,
    sqft: s.squareFootage as number,
  };
  if (isNum(s.yearBuilt)) property.yearBuilt = s.yearBuilt;
  if (isNum(s.lotSize)) property.lotSizeSqft = s.lotSize;
  if (isNum(s.lastSalePrice)) property.lastSalePrice = s.lastSalePrice;
  if (typeof s.lastSaleDate === "string") property.lastSaleDate = s.lastSaleDate;
  return property;
}

/**
 * Comp $/sqft via the engine's single definition. Sale comps: whole dollars.
 * Rent comps: cents (a monthly rate like 2.84). Undefined when price or sqft is unusable.
 */
function compPricePerSqft(c: RentcastComparable, kind: "sale" | "rent"): number | undefined {
  const raw = pricePerSqft(c);
  if (raw === undefined) return undefined;
  return kind === "sale" ? Math.round(raw) : Math.round(raw * 100) / 100;
}

/** Maps a Rentcast comparable, or returns undefined if it lacks a required field. */
function toComp(c: RentcastComparable, status: Comp["status"], kind: "sale" | "rent"): Comp | undefined {
  if (
    typeof c.formattedAddress !== "string" ||
    !isNum(c.bedrooms) ||
    !isNum(c.bathrooms) ||
    !isNum(c.squareFootage) ||
    !isNum(c.price) ||
    !isNum(c.distance)
  ) {
    return undefined;
  }
  const comp: Comp = {
    // Display only: removes Rentcast's stray street comma ("2004 Rue De St, Tropez, ...").
    address: displayAddress(c),
    beds: c.bedrooms,
    baths: c.bathrooms,
    sqft: c.squareFootage,
    price: c.price,
    status,
    distanceMiles: c.distance,
  };
  const perSqft = compPricePerSqft(c, kind);
  if (perSqft !== undefined) comp.pricePerSqft = perSqft;
  return comp;
}

function isComp(c: Comp | undefined): c is Comp {
  return c !== undefined;
}

/** Rentcast's sale-comp status -> contract status. Anything else is dropped. */
const SALE_STATUS: Record<string, Comp["status"]> = {
  Active: "for_sale",
  Inactive: "off_market",
};

/**
 * Sale comps for the response: ALL value comps, in Rentcast's correlation order.
 * Active -> "for_sale". Inactive -> "off_market", never "sold": an Inactive comp is
 * an off-market listing, not a confirmed sale, and its price is the last asking
 * price. A comp with any other or missing status is dropped.
 */
function toSaleComps(comps: RentcastComparable[]): Comp[] {
  return comps
    .map((c) => {
      const status = c.status !== undefined ? SALE_STATUS[c.status] : undefined;
      return status ? toComp(c, status, "sale") : undefined;
    })
    .filter(isComp);
}

/** Every rent comp is a rental, Active or not. */
function toRentComps(comps: RentcastComparable[]): Comp[] {
  return comps.map((c) => toComp(c, "for_lease", "rent")).filter(isComp);
}

function toMarket(zip: string, stats: RentcastMarketStats): MarketSnapshot {
  const medianPrice = stats.saleData?.medianPrice;
  const avgDaysOnMarket = stats.saleData?.averageDaysOnMarket;
  if (!isNum(medianPrice) || !isNum(avgDaysOnMarket)) {
    throw new IncompleteDataError(["marketStats"]);
  }
  return { zip, medianPrice, avgDaysOnMarket };
}

/** The market zip comes from Rentcast's resolved subject, not from the input string. */
function subjectZip(value: RentcastValueEstimate): string {
  const zip = value.subjectProperty?.zipCode;
  if (typeof zip !== "string" || !/^\d{5}$/.test(zip)) {
    throw new IncompleteDataError(["zipCode"]);
  }
  return zip;
}

/** A 404 from /listings/sale means "never listed": no listing, not an error. */
function noListingOn404(err: unknown): RentcastSaleListing[] {
  if (err instanceof RentcastError && err.kind === "http" && err.status === 404) return [];
  throw err;
}

/**
 * A rent 400 once the value call has resolved the address is not a bad address:
 * Rentcast could not estimate rent for this record. -> 422 incomplete_data.
 */
function rentIncompleteOn400(err: unknown): never {
  if (err instanceof RentcastError && err.kind === "http" && err.status === 400) {
    throw new IncompleteDataError(["avmRent"], err);
  }
  throw err;
}

/** The address lookup returns an array and may include an old Inactive listing. */
function findActiveListing(listings: unknown): RentcastSaleListing | undefined {
  if (!Array.isArray(listings)) return undefined;
  return (listings as RentcastSaleListing[]).find((l) => l.status === "Active" && isNum(l.price));
}

export async function buildPropertyReport(
  address: string,
  deps: ReportDeps = {},
): Promise<PropertyReport> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const client = createRentcastClient({ fetch: deps.fetch, apiKey: deps.apiKey, signal: deadline.signal });

  try {
    // Three calls start together, up front. Markets needs the AVM's zip, so it chains
    // off the value call alone (still overlapping the other two) and is skipped when
    // the subject is incomplete, since that request will fail anyway.
    const valueP = client.get<RentcastValueEstimate>("/avm/value", { address });
    const rentP = client.get<RentcastRentEstimate>("/avm/rent/long-term", { address });
    const listingsP = client
      .get<RentcastSaleListing[]>("/listings/sale", { address })
      .catch(noListingOn404);
    const marketsP = valueP.then((value) => {
      toProperty(value.subjectProperty);
      return client.get<RentcastMarketStats>("/markets", { zipCode: subjectZip(value) });
    });
    // Results are checked in a fixed order below, not by whichever call fails first.
    // Mark the rest handled so an early throw never leaves an unhandled rejection.
    for (const p of [rentP, listingsP, marketsP]) p.catch(() => {});

    // 1. Value errors (404, bad address, billing) win.
    const value = await valueP;
    // 2. Then an incomplete subject, whatever the rent call did (it may 400 on one).
    const property = toProperty(value.subjectProperty);
    // 3. Then the rest.
    const rent = await rentP.catch(rentIncompleteOn400);
    const [listings, markets] = await Promise.all([listingsP, marketsP]);

    const subject = value.subjectProperty as RentcastSubjectProperty;
    const computed = computeValuation({
      subject,
      valueEstimate: value,
      rentEstimate: rent,
      activeListing: findActiveListing(listings),
    });

    return {
      property,
      valuation: computed.valuation,
      comps: toSaleComps(value.comparables ?? []),
      rent: { ...computed.rent, rentComps: toRentComps(rent.comparables ?? []) },
      market: toMarket(subjectZip(value), markets),
    };
  } finally {
    clearTimeout(timer);
    deadline.abort(); // cancel anything still in flight after a failure
  }
}
