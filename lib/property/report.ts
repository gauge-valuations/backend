// Builds a PropertyReport for one address from four Rentcast calls.

import { IncompleteDataError } from "@/lib/errors";
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

function toProperty(subject: RentcastSubjectProperty | undefined): Property {
  const s = subject ?? {};
  const required = {
    address: s.formattedAddress,
    beds: s.bedrooms,
    baths: s.bathrooms,
    sqft: s.squareFootage,
    yearBuilt: s.yearBuilt,
    lotSizeSqft: s.lotSize,
  };
  const missing = Object.entries(required)
    .filter(([key, v]) => (key === "address" ? typeof v !== "string" || v === "" : !isNum(v)))
    .map(([key]) => key);
  if (missing.length > 0) throw new IncompleteDataError(`subject ${missing.join(",")}`);

  const property: Property = {
    address: s.formattedAddress as string,
    beds: s.bedrooms as number,
    baths: s.bathrooms as number,
    sqft: s.squareFootage as number,
    yearBuilt: s.yearBuilt as number,
    lotSizeSqft: s.lotSize as number,
  };
  if (isNum(s.lastSalePrice)) property.lastSalePrice = s.lastSalePrice;
  if (typeof s.lastSaleDate === "string") property.lastSaleDate = s.lastSaleDate;
  return property;
}

/** Maps a Rentcast comparable, or returns undefined if it lacks a required field. */
function toComp(c: RentcastComparable, status: Comp["status"]): Comp | undefined {
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
  return {
    // formattedAddress is used whole, never split, so stray commas
    // ("2004 Rue De St, Tropez, ...") are harmless.
    address: c.formattedAddress,
    beds: c.bedrooms,
    baths: c.bathrooms,
    sqft: c.squareFootage,
    price: c.price,
    status,
    distanceMiles: c.distance,
  };
}

function toComps(comps: RentcastComparable[], status: Comp["status"]): Comp[] {
  return comps.map((c) => toComp(c, status)).filter((c): c is Comp => c !== undefined);
}

/**
 * Sale comps for the response: Active only, mapped to "for_sale", in Rentcast's
 * correlation order. Inactive comps are off-market listings, NOT sales, so they are
 * not shown as "sold". A future contract change will add an "off_market" status so
 * inactive comps can be shown; until then they are used only as engine input.
 */
function toSaleComps(comps: RentcastComparable[]): Comp[] {
  return toComps(comps.filter((c) => c.status === "Active"), "for_sale");
}

/** Every rent comp is a rental, Active or not. */
function toRentComps(comps: RentcastComparable[]): Comp[] {
  return toComps(comps, "for_lease");
}

function toMarket(zip: string, stats: RentcastMarketStats): MarketSnapshot {
  const medianPrice = stats.saleData?.medianPrice;
  const avgDaysOnMarket = stats.saleData?.averageDaysOnMarket;
  if (!isNum(medianPrice) || !isNum(avgDaysOnMarket)) {
    throw new IncompleteDataError("market saleData");
  }
  return { zip, medianPrice, avgDaysOnMarket };
}

/** The market zip comes from Rentcast's resolved subject, not from the input string. */
function subjectZip(value: RentcastValueEstimate): string {
  const zip = value.subjectProperty?.zipCode;
  if (typeof zip !== "string" || !/^\d{5}$/.test(zip)) {
    throw new IncompleteDataError("subject zipCode");
  }
  return zip;
}

/** A 404 from /listings/sale means "never listed": no listing, not an error. */
function noListingOn404(err: unknown): RentcastSaleListing[] {
  if (err instanceof RentcastError && err.kind === "http" && err.status === 404) return [];
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
    // Three calls start together; markets needs the AVM's zip, so it chains off the
    // value call alone and still overlaps the other two.
    const valueP = client.get<RentcastValueEstimate>("/avm/value", { address });
    const rentP = client.get<RentcastRentEstimate>("/avm/rent/long-term", { address });
    const listingsP = client
      .get<RentcastSaleListing[]>("/listings/sale", { address })
      .catch(noListingOn404);
    const marketsP = valueP.then((value) =>
      client.get<RentcastMarketStats>("/markets", { zipCode: subjectZip(value) }),
    );

    const [value, rent, listings, markets] = await Promise.all([valueP, rentP, listingsP, marketsP]);

    const property = toProperty(value.subjectProperty);
    const subject = value.subjectProperty as RentcastSubjectProperty;
    const { valuation, monthlyRent } = computeValuation({
      subject,
      valueEstimate: value,
      rentEstimate: rent,
      activeListing: findActiveListing(listings),
    });

    return {
      property,
      valuation,
      comps: toSaleComps(value.comparables ?? []),
      rent: { monthlyRent, rentComps: toRentComps(rent.comparables ?? []) },
      market: toMarket(subjectZip(value), markets),
    };
  } finally {
    clearTimeout(timer);
    deadline.abort(); // cancel anything still in flight after a failure
  }
}
