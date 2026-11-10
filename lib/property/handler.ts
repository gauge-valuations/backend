// Request handling for GET /api/property, kept out of route.ts so tests can call it
// with a fake fetch.

import { IncompleteDataError, InvalidAddressError, toHttpError } from "@/lib/errors";
import { buildPropertyReport, type ReportDeps } from "@/lib/property/report";
import { RentcastError } from "@/lib/rentcast/client";
import { parsePropertyReport } from "@/lib/types";

export type HandlerDeps = ReportDeps & {
  /** Receives one short line per failure. Never a body, header, or key. */
  log?: (line: string) => void;
};

const MIN_ADDRESS_LENGTH = 5;
const MAX_ADDRESS_LENGTH = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function parseAddress(raw: string | null): string {
  const address = raw?.trim() ?? "";
  if (
    address.length < MIN_ADDRESS_LENGTH ||
    address.length > MAX_ADDRESS_LENGTH ||
    CONTROL_CHARS.test(address)
  ) {
    throw new InvalidAddressError();
  }
  return address;
}

/** A log line that is safe by construction: no upstream text, URLs, or headers. */
function describe(err: unknown): string {
  if (err instanceof RentcastError) return err.message; // "rentcast <endpoint> <status|kind> <code>"
  if (err instanceof IncompleteDataError) return err.message; // names missing fields only
  return `property ${err instanceof Error ? err.name : "unknown"}`;
}

export async function handlePropertyRequest(
  request: Request,
  deps: HandlerDeps = {},
): Promise<Response> {
  const log = deps.log ?? ((line: string) => console.error(line));
  try {
    const address = parseAddress(new URL(request.url).searchParams.get("address"));
    // Check our own output against the shared contract before sending it.
    const report = parsePropertyReport(await buildPropertyReport(address, deps));
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const { status, body } = toHttpError(err);
    if (!(err instanceof InvalidAddressError)) log(describe(err));
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
