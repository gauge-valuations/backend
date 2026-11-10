// Rentcast's own response shapes (not the app contract -- see lib/types.ts).
//
// Field names are verified against the captured fixtures in fixtures/rentcast/raw/.
// Every field is optional: the client strips nulls (lib/normalize/nulls.ts) and
// Rentcast may omit data, so the mapping code checks each value before use.
// Fields we never read (agent/office contact info, HOA, listing history) are left out.

type RentcastAddressFields = {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  stateFips?: string;
  zipCode?: string;
  county?: string;
  countyFips?: string;
  latitude?: number;
  longitude?: number;
};

type RentcastPropertyFields = {
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number;
  yearBuilt?: number;
};

/** `subjectProperty` in /avm/value and /avm/rent/long-term. */
export type RentcastSubjectProperty = RentcastAddressFields &
  RentcastPropertyFields & {
    lastSaleDate?: string;
    /** null (so absent after stripping) in the Texas fixtures. */
    lastSalePrice?: number;
  };

/** An entry in `comparables` (same shape in the value and rent AVMs). */
export type RentcastComparable = RentcastAddressFields &
  RentcastPropertyFields & {
    /** "Active" or "Inactive" in the fixtures. Inactive = off-market, not necessarily sold. */
    status?: string;
    /** List price (value AVM) or monthly rent (rent AVM). */
    price?: number;
    listingType?: string;
    listedDate?: string;
    removedDate?: string;
    lastSeenDate?: string;
    daysOnMarket?: number;
    /** Miles from the subject property. */
    distance?: number;
    daysOld?: number;
    /** Similarity to the subject, 0-1. Comparables arrive sorted by this, highest first. */
    correlation?: number;
  };

/** GET /avm/value */
export type RentcastValueEstimate = {
  price?: number;
  priceRangeLow?: number;
  priceRangeHigh?: number;
  latitude?: number;
  longitude?: number;
  subjectProperty?: RentcastSubjectProperty;
  comparables?: RentcastComparable[];
};

/** GET /avm/rent/long-term */
export type RentcastRentEstimate = {
  rent?: number;
  rentRangeLow?: number;
  rentRangeHigh?: number;
  latitude?: number;
  longitude?: number;
  subjectProperty?: RentcastSubjectProperty;
  comparables?: RentcastComparable[];
};

/**
 * One element of GET /listings/sale. An address lookup returns an ARRAY, and can
 * return an old Inactive listing with HTTP 200.
 */
export type RentcastSaleListing = RentcastAddressFields &
  RentcastPropertyFields & {
    status?: string;
    price?: number;
    listingType?: string;
    listedDate?: string;
    removedDate?: string;
    createdDate?: string;
    lastSeenDate?: string;
    daysOnMarket?: number;
  };

/** `saleData` / `rentalData` in GET /markets (only the fields we may read). */
export type RentcastMarketData = {
  lastUpdatedDate?: string;
  averagePrice?: number;
  medianPrice?: number;
  averageRent?: number;
  medianRent?: number;
  averagePricePerSquareFoot?: number;
  medianPricePerSquareFoot?: number;
  averageDaysOnMarket?: number;
  medianDaysOnMarket?: number;
  newListings?: number;
  totalListings?: number;
};

/** GET /markets */
export type RentcastMarketStats = {
  id?: string;
  zipCode?: string;
  saleData?: RentcastMarketData;
  rentalData?: RentcastMarketData;
};

/** Error body, e.g. { status: 400, error: "resource/bad-request", message: "..." }. */
export type RentcastErrorBody = {
  status?: number;
  error?: string;
  message?: string;
};
