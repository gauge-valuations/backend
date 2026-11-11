// Maps any failure to a safe HTTP error: { error: <short code>, message: <fixed text> }.
// Messages are fixed strings, so no upstream text (which could echo input or anything
// sensitive) ever reaches a client.

import { RentcastError } from "@/lib/rentcast/client";

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_address"
  | "not_found"
  | "upstream_billing"
  | "upstream_unavailable"
  | "upstream_incomplete"
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

/** The request's address failed local validation. */
export class InvalidAddressError extends Error {
  constructor() {
    super("invalid address");
    this.name = "InvalidAddressError";
  }
}

/** Rentcast answered 200 but without data the contract requires. */
export class IncompleteDataError extends Error {
  constructor(what: string) {
    super(`incomplete upstream data: ${what}`);
    this.name = "IncompleteDataError";
  }
}

const ERRORS: Record<ApiErrorCode, HttpError> = {
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
  upstream_incomplete: {
    status: 502,
    body: { error: "upstream_incomplete", message: "The property data provider returned incomplete data for this address." },
  },
  internal_error: {
    status: 500,
    body: { error: "internal_error", message: "Something went wrong." },
  },
};

function isBillingCode(code: string): boolean {
  return /quota|billing|subscription/i.test(code);
}

function codeForRentcast(err: RentcastError): ApiErrorCode {
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
  if (err instanceof InvalidAddressError) return ERRORS.invalid_address;
  if (err instanceof IncompleteDataError) return ERRORS.upstream_incomplete;
  if (err instanceof RentcastError) return ERRORS[codeForRentcast(err)];
  return ERRORS.internal_error;
}
