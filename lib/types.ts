// Shared data contract with the backend. The backend returns exactly this shape.
// Extend these types — never fork them. See CLAUDE.md.

export type Property = {
  address: string;
  beds: number;
  baths: number;
  sqft: number;
  // Year the home was built. Optional: condo and land records often lack it.
  yearBuilt?: number;
  // Lot size in square feet. Optional: condo and land records often lack it.
  lotSizeSqft?: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
};

export type Valuation = {
  estimatedValue: number;
  listPrice?: number;
  potentialMargin?: number; // backend may omit; client derives estimatedValue - listPrice when listPrice exists
  // Estimated value per square foot of living area, in dollars.
  pricePerSqft?: number;
  // Low end of the likely value range, in dollars.
  valueRangeLow?: number;
  // High end of the likely value range, in dollars.
  valueRangeHigh?: number;
  // True when few comparable homes were usable, so the estimate is less reliable.
  lowConfidence?: boolean;
};

export type Comp = {
  address: string;
  beds: number;
  baths: number;
  sqft: number;
  price: number;
  // "off_market": an inactive listing that is NOT a confirmed sale; its price is
  // the last asking price, not a sale price.
  status: "for_sale" | "sold" | "for_lease" | "off_market";
  distanceMiles: number;
  // price / sqft in dollars (for rent comps: monthly rent per square foot).
  pricePerSqft?: number;
};

export type RentEstimate = {
  monthlyRent: number;
  rentComps: Comp[];
  // Estimated monthly rent per square foot, in dollars.
  rentPerSqft?: number;
  // Low end of the likely monthly rent range, in dollars.
  rentRangeLow?: number;
  // High end of the likely monthly rent range, in dollars.
  rentRangeHigh?: number;
};

export type MarketSnapshot = {
  zip: string;
  medianPrice: number;
  avgDaysOnMarket: number;
};

export type PropertyReport = {
  property: Property;
  valuation: Valuation;
  comps: Comp[];
  rent: RentEstimate;
  market: MarketSnapshot;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isComp(value: unknown): value is Comp {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.address === "string" &&
    isFiniteNumber(c.beds) &&
    isFiniteNumber(c.baths) &&
    isFiniteNumber(c.sqft) &&
    isFiniteNumber(c.price) &&
    (c.status === "for_sale" ||
      c.status === "sold" ||
      c.status === "for_lease" ||
      c.status === "off_market") &&
    isFiniteNumber(c.distanceMiles) &&
    isOptionalFiniteNumber(c.pricePerSqft)
  );
}

function isProperty(value: unknown): value is Property {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.address === "string" &&
    isFiniteNumber(p.beds) &&
    isFiniteNumber(p.baths) &&
    isFiniteNumber(p.sqft) &&
    isOptionalFiniteNumber(p.yearBuilt) &&
    isOptionalFiniteNumber(p.lotSizeSqft) &&
    isOptionalFiniteNumber(p.lastSalePrice) &&
    (p.lastSaleDate === undefined || typeof p.lastSaleDate === "string")
  );
}

function isValuation(value: unknown): value is Valuation {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isFiniteNumber(v.estimatedValue) &&
    isOptionalFiniteNumber(v.listPrice) &&
    isOptionalFiniteNumber(v.potentialMargin) &&
    isOptionalFiniteNumber(v.pricePerSqft) &&
    isOptionalFiniteNumber(v.valueRangeLow) &&
    isOptionalFiniteNumber(v.valueRangeHigh) &&
    isOptionalBoolean(v.lowConfidence)
  );
}

function isRentEstimate(value: unknown): value is RentEstimate {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    isFiniteNumber(r.monthlyRent) &&
    Array.isArray(r.rentComps) &&
    r.rentComps.every(isComp) &&
    isOptionalFiniteNumber(r.rentPerSqft) &&
    isOptionalFiniteNumber(r.rentRangeLow) &&
    isOptionalFiniteNumber(r.rentRangeHigh)
  );
}

function isMarketSnapshot(value: unknown): value is MarketSnapshot {
  if (value === null || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.zip === "string" &&
    isFiniteNumber(m.medianPrice) &&
    isFiniteNumber(m.avgDaysOnMarket)
  );
}

/** Runtime check for API JSON. Throws if the payload does not match PropertyReport. */
export function parsePropertyReport(data: unknown): PropertyReport {
  if (data === null || typeof data !== "object") {
    throw new Error("Invalid property report: expected an object");
  }
  const report = data as Record<string, unknown>;
  if (
    !isProperty(report.property) ||
    !isValuation(report.valuation) ||
    !Array.isArray(report.comps) ||
    !report.comps.every(isComp) ||
    !isRentEstimate(report.rent) ||
    !isMarketSnapshot(report.market)
  ) {
    throw new Error("Invalid property report: payload does not match contract");
  }
  return data as PropertyReport;
}
