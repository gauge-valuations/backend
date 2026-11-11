// Display address for a property or comp, cleaned of stray commas inside the street.
//
// Rentcast sometimes splits a street name across addressLine1 and addressLine2, e.g.
// "2305 Trail" + "of the Madrones", and its formattedAddress repeats the split:
// "2305 Trail, of the Madrones, Austin, TX 78746". A second line that is not a unit
// (Apt, Unit, Ste, # ...) is the rest of the street name, so it is joined with a space.
//
// Display only: this never affects which comps are used or how they are weighted, and
// it is unrelated to the cache key (lib/address.ts normalizes the user's typed address).

export type AddressFields = {
  formattedAddress?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
};

/** A street part that names a unit, so it keeps its comma ("123 Main St, Apt 4"). */
const UNIT_PART = /^(#|(apt|apartment|unit|ste|suite|bldg|building|fl|floor|rm|room|lot|spc|space|ph|penthouse|trlr|dept)\b)/i;

/** ", City, ST 12345" (optionally ZIP+4) at the end of a formatted address. */
const CITY_STATE_ZIP_TAIL = /^(.+?), ([^,]+), ([A-Za-z]{2}) (\d{5}(?:-\d{4})?)$/;

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Joins street parts: a unit keeps its comma, anything else continues the street name. */
function joinStreet(parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .reduce((street, part) => (street === "" ? part : UNIT_PART.test(part) ? `${street}, ${part}` : `${street} ${part}`), "");
}

/**
 * Rebuilds "street, City, ST 12345" from the structured fields when line 1, city, state
 * and zip are all present. Otherwise cleans formattedAddress: commas inside the street
 * part (everything before the city, state, zip tail) are removed unless a unit follows.
 * Without a recognizable tail, formattedAddress is returned with whitespace collapsed.
 */
export function displayAddress(fields: AddressFields): string {
  const line1 = clean(fields.addressLine1);
  const city = clean(fields.city);
  const state = clean(fields.state);
  const zip = clean(fields.zipCode);
  if (line1 && city && state && zip) {
    return `${joinStreet([line1, clean(fields.addressLine2)])}, ${city}, ${state} ${zip}`;
  }

  const formatted = clean(fields.formattedAddress).replace(/\s*,\s*/g, ", ");
  const match = CITY_STATE_ZIP_TAIL.exec(formatted);
  if (!match) return formatted;
  const [, street, tailCity, tailState, tailZip] = match;
  return `${joinStreet(street.split(", "))}, ${tailCity}, ${tailState} ${tailZip}`;
}
