// Rentcast uses `null` for "no value" (e.g. lastSalePrice in Texas, a non-disclosure
// state). The contract uses optional fields instead, so nulls are removed: a null
// object value drops its key, and a null array element is dropped.
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null).map(stripNulls);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null) out[key] = stripNulls(item);
    }
    return out;
  }
  return value;
}
