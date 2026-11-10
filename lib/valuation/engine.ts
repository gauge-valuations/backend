// Valuation engine: comparable-sales $/sqft, weighted by similarity.
//
// 1. Turn each comparable into a price per square foot; skip comps without usable numbers.
// 2. With 5+ comps, drop $/sqft outliers outside the 1.5x IQR fences (the box-plot rule).
// 3. Take the weighted median $/sqft, weighting each comp by Rentcast's correlation (0-1),
//    so closer matches count more. Weighted 25th/75th percentiles give a range.
// 4. Multiply by the subject's square footage. Rent repeats steps 1-4 on rental comps.
// 5. Fewer than 3 usable comps is low-confidence: fall back to Rentcast's own AVM number
//    and report source = "rentcast_fallback".
// Pure functions only (no network). Dollar amounts are rounded once, at the very end.

/** The comp fields the engine reads (a subset of Rentcast's comparable). */
export type EngineComp = {
  price?: number;
  squareFootage?: number;
  correlation?: number;
};

/** Rentcast's own estimate, used when we have too few comps. */
export type FallbackEstimate = {
  value: number;
  low?: number;
  high?: number;
};

export type EstimateSource = "engine" | "rentcast_fallback";

type Estimate = {
  amount: number;
  low: number;
  high: number;
  perSqft: number;
  usableComps: number;
  droppedComps: number;
  source: EstimateSource;
  lowConfidence: boolean;
};

export type ValueResult = {
  value: number;
  valueLow: number;
  valueHigh: number;
  pricePerSqft: number;
  usableComps: number;
  droppedComps: number;
  source: EstimateSource;
  lowConfidence: boolean;
};

export type RentResult = {
  rent: number;
  rentLow: number;
  rentHigh: number;
  rentPerSqft: number;
  usableComps: number;
  droppedComps: number;
  source: EstimateSource;
  lowConfidence: boolean;
};

export type WeightedPoint = { value: number; weight: number };

export const MIN_COMPS_FOR_ENGINE = 3;
export const MIN_COMPS_FOR_OUTLIER_FILTER = 5;

function isPositive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Step 1: price / sqft, or undefined when the comp can't be used. */
export function pricePerSqft(comp: EngineComp): number | undefined {
  if (!isPositive(comp.price) || !isPositive(comp.squareFootage)) return undefined;
  return comp.price / comp.squareFootage;
}

/** Comps with a valid $/sqft and a positive correlation weight. */
function toWeightedPoints(comps: EngineComp[]): WeightedPoint[] {
  const points: WeightedPoint[] = [];
  for (const comp of comps) {
    const value = pricePerSqft(comp);
    if (value !== undefined && isPositive(comp.correlation)) {
      points.push({ value, weight: comp.correlation });
    }
  }
  return points;
}

/**
 * Plain (unweighted) quantile with linear interpolation between sorted values
 * (the common "type 7" definition, same as Excel QUARTILE.INC / numpy default).
 */
export function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

/** Step 2: drop points outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]. Fewer than 5 points: keep all. */
export function removeOutliers(points: WeightedPoint[]): WeightedPoint[] {
  if (points.length < MIN_COMPS_FOR_OUTLIER_FILTER) return points;
  const values = points.map((p) => p.value);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  return points.filter((p) => p.value >= lowFence && p.value <= highFence);
}

/**
 * Weighted percentile: sort by value, walk the cumulative weight, and return the
 * first value where it reaches p * totalWeight.
 *
 * Ties: equal values sit next to each other after sorting, so their weights simply
 * add up; which of them is "first" never changes the answer. When the cumulative
 * weight lands exactly on the target, that (lower) value is returned -- we do not
 * average it with the next one. A tiny tolerance absorbs floating-point error in
 * the running sum (e.g. 0.1 + 0.2 + 0.2 vs 0.5).
 */
export function weightedPercentile(points: WeightedPoint[], p: number): number {
  if (points.length === 0) throw new Error("weightedPercentile needs at least one point");
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, pt) => sum + pt.weight, 0);
  const target = p * total;
  const tolerance = 1e-9 * total;
  let cumulative = 0;
  for (const pt of sorted) {
    cumulative += pt.weight;
    if (cumulative >= target - tolerance) return pt.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Step 3: the weighted median is the 50th weighted percentile. */
export function weightedMedian(points: WeightedPoint[]): number {
  return weightedPercentile(points, 0.5);
}

const roundDollars = (n: number) => Math.round(n);
const roundCents = (n: number) => Math.round(n * 100) / 100;

/** Step 5: too few comps (or no usable subject sqft) -> use Rentcast's number. */
function fallbackEstimate(
  fallback: FallbackEstimate,
  subjectSqft: number | undefined,
  usableComps: number,
  droppedComps: number,
): Estimate {
  return {
    amount: roundDollars(fallback.value),
    low: roundDollars(fallback.low ?? fallback.value),
    high: roundDollars(fallback.high ?? fallback.value),
    perSqft: isPositive(subjectSqft) ? roundCents(fallback.value / subjectSqft) : 0,
    usableComps,
    droppedComps,
    source: "rentcast_fallback",
    lowConfidence: true,
  };
}

/** Steps 1-5 for one quantity (sale value or rent). */
export function estimateFromComps(
  comps: EngineComp[],
  subjectSqft: number | undefined,
  fallback: FallbackEstimate,
): Estimate {
  const usable = removeOutliers(toWeightedPoints(comps));
  const droppedComps = comps.length - usable.length; // skipped + outliers

  if (usable.length < MIN_COMPS_FOR_ENGINE || !isPositive(subjectSqft)) {
    return fallbackEstimate(fallback, subjectSqft, usable.length, droppedComps);
  }

  const medianPerSqft = weightedMedian(usable);
  return {
    amount: roundDollars(medianPerSqft * subjectSqft),
    low: roundDollars(weightedPercentile(usable, 0.25) * subjectSqft),
    high: roundDollars(weightedPercentile(usable, 0.75) * subjectSqft),
    perSqft: roundCents(medianPerSqft),
    usableComps: usable.length,
    droppedComps,
    source: "engine",
    lowConfidence: false,
  };
}

/** Step 4: market value from sale comps. */
export function estimateValue(
  comps: EngineComp[],
  subjectSqft: number | undefined,
  fallback: FallbackEstimate,
): ValueResult {
  const e = estimateFromComps(comps, subjectSqft, fallback);
  return {
    value: e.amount,
    valueLow: e.low,
    valueHigh: e.high,
    pricePerSqft: e.perSqft,
    usableComps: e.usableComps,
    droppedComps: e.droppedComps,
    source: e.source,
    lowConfidence: e.lowConfidence,
  };
}

/** Steps 1-5 for rent (comp.price is the monthly rent). */
export function estimateRent(
  comps: EngineComp[],
  subjectSqft: number | undefined,
  fallback: FallbackEstimate,
): RentResult {
  const e = estimateFromComps(comps, subjectSqft, fallback);
  return {
    rent: e.amount,
    rentLow: e.low,
    rentHigh: e.high,
    rentPerSqft: e.perSqft,
    usableComps: e.usableComps,
    droppedComps: e.droppedComps,
    source: e.source,
    lowConfidence: e.lowConfidence,
  };
}
