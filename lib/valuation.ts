// The valuation swap point: everything that decides estimatedValue and monthlyRent
// goes through computeValuation(). Swap the method here without touching the route.

import { IncompleteDataError } from "@/lib/errors";
import type {
  RentcastRentEstimate,
  RentcastSaleListing,
  RentcastSubjectProperty,
  RentcastValueEstimate,
} from "@/lib/rentcast/responses";
import type { Valuation } from "@/lib/types";
import { estimateRent, estimateValue, type RentResult, type ValueResult } from "@/lib/valuation/engine";

export type ValuationInput = {
  subject: RentcastSubjectProperty;
  valueEstimate: RentcastValueEstimate;
  rentEstimate: RentcastRentEstimate;
  /** The subject's current Active listing, if any. */
  activeListing?: RentcastSaleListing;
};

export type ValuationOutput = {
  valuation: Valuation;
  monthlyRent: number;
  /** Engine detail kept internal until the contract can carry it. */
  internal: { value: ValueResult; rent: RentResult };
};

function requireNumber(n: number | undefined, what: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new IncompleteDataError(what);
  return n;
}

export function computeValuation(input: ValuationInput): ValuationOutput {
  const { subject, valueEstimate, rentEstimate, activeListing } = input;

  // The engine sees ALL value comps, Active and Inactive (off-market listings are
  // still useful price evidence), even though the response only shows Active ones.
  const value = estimateValue(valueEstimate.comparables ?? [], subject.squareFootage, {
    value: requireNumber(valueEstimate.price, "avm price"),
    low: valueEstimate.priceRangeLow,
    high: valueEstimate.priceRangeHigh,
  });

  const rent = estimateRent(rentEstimate.comparables ?? [], subject.squareFootage, {
    value: requireNumber(rentEstimate.rent, "avm rent"),
    low: rentEstimate.rentRangeLow,
    high: rentEstimate.rentRangeHigh,
  });

  const valuation: Valuation = { estimatedValue: value.value };
  if (activeListing && typeof activeListing.price === "number" && Number.isFinite(activeListing.price)) {
    valuation.listPrice = activeListing.price;
  }
  // potentialMargin is deliberately omitted: the client derives it.

  // STEP 5 SURFACING POINT: value.pricePerSqft, value.valueLow/valueHigh,
  // value.source/lowConfidence (and the rent equivalents) are returned here as
  // `internal` only. Expose them in the response once the shared contract gains fields.
  return { valuation, monthlyRent: rent.rent, internal: { value, rent } };
}
