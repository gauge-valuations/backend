// Maps any failure to a safe HTTP error: { error: <short code>, message: <fixed text> }.
// Messages are fixed strings (or, for incomplete_data, built only from fixed field
// labels), so no upstream text (which could echo input or anything sensitive) ever
// reaches a client.

import { RentcastError } from "@/lib/rentcast/client";

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_address"
  | "not_found"
  | "upstream_billing"
  | "upstream_unavailable"
  | "incomplete_data"
  | "internal_error";

export type ApiErrorBody = { error: ApiErrorCode; message: string };

export type HttpError = { status: number; body: ApiErrorBody };

/**
 * Our own demo gate rejected the request (missing or wrong X-Demo-Key). Distinct
 * from an upstream 401, which is our Rentcast key/config problem and maps to 500.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * Our monthly call budget refused to spend (cap reached, or the budget check could
 * not run). Answered like a billing problem: 402 upstream_billing, no Rentcast call.
 * The message is a fixed, safe log line.
 */
export class CallBudgetError extends Error {
  constructor(logLine: "monthly call budget reached" | "budget check failed" | "budget check failed: no shared counter") {
    super(logLine);
    this.name = "CallBudgetError";
  }
}

/** The request's address failed local validation. */
export class InvalidAddressError extends Error {
  constructor() {
    super("invalid address");
    this.name = "InvalidAddressError";
  }
}

/** A piece of upstream data the report cannot be built without. */
export type IncompleteField =
  | "address"
  | "beds"
  | "baths"
  | "sqft"
  | "zipCode"
  | "avmPrice"
  | "avmRent"
  | "marketStats";

/** Log names: the same safe text the logs carried before ("subject beds"). */
const FIELD_LOG: Record<IncompleteField, string> = {
  address: "subject address",
  beds: "subject beds",
  baths: "subject baths",
  sqft: "subject sqft",
  zipCode: "subject zipCode",
  avmPrice: "avm price",
  avmRent: "avm rent",
  marketStats: "market saleData",
};

/** Plain names for the response message (for logs and API users, not app UI). */
const FIELD_LABEL: Record<IncompleteField, string> = {
  address: "street address",
  beds: "bedroom count",
  baths: "bathroom count",
  sqft: "square footage",
  zipCode: "ZIP code",
  avmPrice: "value estimate",
  avmRent: "rent estimate",
  marketStats: "market statistics",
};

/**
 * Rentcast's record lacks data the contract requires. Answered 422 incomplete_data
 * naming the missing fields; nothing is guessed or defaulted. `upstream` is the
 * Rentcast failure that signalled it (e.g. a rent 400), kept for the log line only.
 */
export class IncompleteDataError extends Error {
  readonly fields: readonly IncompleteField[];

  constructor(fields: readonly IncompleteField[], upstream?: RentcastError) {
    const what = fields.map((f) => FIELD_LOG[f]).join(", ");
    super(`incomplete upstream data: ${what}${upstream ? `; ${upstream.message}` : ""}`);
    this.name = "IncompleteDataError";
    this.fields = fields;
  }
}

function incompleteDataError(err: IncompleteDataError): HttpError {
  const labels = err.fields.map((f) => FIELD_LABEL[f]);
  return {
    status: 422,
    body: {
      error: "incomplete_data",
      message: `The property record for this address is missing: ${labels.join(", ")}.`,
    },
  };
}

const ERRORS: Record<Exclude<ApiErrorCode, "incomplete_data">, HttpError> = {
  unauthorized: {
    status: 401,
    body: { error: "unauthorized", message: "This request is not authorized." },
  },
  invalid_address: {
    status: 400,
    body: { error: "invalid_address", message: "The address is missing or could not be understood." },
  },
  not_found: {
    status: 404,
    body: { error: "not_found", message: "No property data was found for this address." },
  },
  upstream_billing: {
    status: 402,
    body: { error: "upstream_billing", message: "The property data provider is unavailable for billing reasons." },
  },
  upstream_unavailable: {
    status: 502,
    body: { error: "upstream_unavailable", message: "The property data provider did not respond. Try again." },
  },
  internal_error: {
    status: 500,
    body: { error: "internal_error", message: "Something went wrong." },
  },
};

function isBillingCode(code: string): boolean {
  return /quota|billing|subscription/i.test(code);
}

function codeForRentcast(err: RentcastError): keyof typeof ERRORS {
  if (err.kind === "timeout" || err.kind === "network" || err.kind === "parse") {
    return "upstream_unavailable";
  }
  if (err.kind === "config") return "internal_error";

  // Body error code first...
  if (err.code === "resource/bad-request") return "invalid_address";
  if (err.code && isBillingCode(err.code)) return "upstream_billing";

  // ...then status.
  const status = err.status ?? 0;
  if (status === 400) return "invalid_address";
  if (status === 404) return "not_found";
  if (status === 429) return "upstream_unavailable"; // rate limit: temporary
  if (status >= 500) return "upstream_unavailable";
  return "internal_error"; // includes 401 (our key/config problem) and other 403s
}

export function toHttpError(err: unknown): HttpError {
  if (err instanceof UnauthorizedError) return ERRORS.unauthorized;
  if (err instanceof CallBudgetError) return ERRORS.upstream_billing;
  if (err instanceof InvalidAddressError) return ERRORS.invalid_address;
  if (err instanceof IncompleteDataError) return incompleteDataError(err);
  if (err instanceof RentcastError) return ERRORS[codeForRentcast(err)];
  return ERRORS.internal_error;
}
