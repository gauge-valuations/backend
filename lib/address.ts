// Cache-key normalization for addresses. Used ONLY to build the cache key; the
// original address string is what goes to Rentcast.
//
// Conservative on purpose: it only removes differences in case, spacing, commas,
// periods and common USPS word forms. It never drops tokens, so unit numbers, house
// numbers and zip codes always stay in the key and two different homes never merge.

const ABBREVIATIONS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  drive: "dr",
  lane: "ln",
  road: "rd",
  boulevard: "blvd",
  court: "ct",
  place: "pl",
  circle: "cir",
  terrace: "ter",
  highway: "hwy",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  texas: "tx",
};

export function normalizeAddressKey(address: string): string {
  return (
    address
      .toLowerCase()
      // Commas, and periods that aren't decimal points ("4.5"), become word breaks
      // so "Ln,Austin" can't fuse into one token.
      .replace(/,|\.(?!\d)|(?<!\d)\./g, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .map((word) => ABBREVIATIONS[word] ?? word)
      .join(" ")
  );
}
