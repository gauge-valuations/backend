// The valuation swap point: everything that decides estimatedValue and monthlyRent
// goes through computeValuation(). Swap the method here without touching the route.

import { IncompleteDataError, type IncompleteField } from "@/lib/errors";
import type {
  RentcastRentEstimate,
  RentcastSaleListing,
  RentcastSubjectProperty,
  RentcastValueEstimate,
} from "@/lib/rentcast/responses";
import type { RentEstimate, Valuation } from "@/lib/types";
import { estimateRent, estimateValue, type RentResult, type ValueResult } from "@/lib/valuation/engine";

export type ValuationInput = {
  subject: RentcastSubjectProperty;
  valueEstimate: RentcastValueEstimate;
  rentEstimate: RentcastRentEstimate;
  /** The subject's current Active listing, if any. */
  activeListing?: RentcastSaleListing;
};

/** The RentEstimate fields this module decides (rent comps are added by the report). */
export type RentFigures = Omit<RentEstimate, "rentComps">;

export type ValuationOutput = {
  valuation: Valuation;
  rent: RentFigures;
  /** Full engine results (comp counts, source), not part of the contract. */
  internal: { value: ValueResult; rent: RentResult };
};

function requireNumber(n: number | undefined, field: IncompleteField): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new IncompleteDataError([field]);
  return n;
}

export function computeValuation(input: ValuationInput): ValuationOutput {
  const { subject, valueEstimate, rentEstimate, activeListing } = input;

  // The engine sees ALL value comps, Active and Inactive (off-market listings are
  // still useful price evidence).
  const value = estimateValue(valueEstimate.comparables ?? [], subject.squareFootage, {
    value: requireNumber(valueEstimate.price, "avmPrice"),
    low: valueEstimate.priceRangeLow,
    high: valueEstimate.priceRangeHigh,
  });

  const rent = estimateRent(rentEstimate.comparables ?? [], subject.squareFootage, {
    value: requireNumber(rentEstimate.rent, "avmRent"),
    low: rentEstimate.rentRangeLow,
    high: rentEstimate.rentRangeHigh,
  });

  const valuation: Valuation = { estimatedValue: value.value };
  if (activeListing && typeof activeListing.price === "number" && Number.isFinite(activeListing.price)) {
    valuation.listPrice = activeListing.price;
  }
  // potentialMargin is deliberately omitted: the client derives it.
  // pricePerSqft stays at the engine's cent precision; the client rounds for display.
  valuation.pricePerSqft = value.pricePerSqft;
  valuation.valueRangeLow = value.valueLow;
  valuation.valueRangeHigh = value.valueHigh;
  // Only present when true, so a normal estimate carries no flag at all.
  if (value.lowConfidence) valuation.lowConfidence = true;

  const rentFigures: RentFigures = {
    monthlyRent: rent.rent,
    rentPerSqft: rent.rentPerSqft,
    rentRangeLow: rent.rentLow,
    rentRangeHigh: rent.rentHigh,
  };

  return { valuation, rent: rentFigures, internal: { value, rent } };
}
