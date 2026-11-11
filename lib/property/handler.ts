// Request handling for GET /api/property, kept out of route.ts so tests can call it
// with a fake fetch, a fake cache, and explicit gate/CORS settings.
//
// Order: CORS headers -> demo gate -> address validation -> cache lookup ->
// build report -> cache write.

import { normalizeAddressKey } from "@/lib/address";
import { getDefaultCache, type ReportCache } from "@/lib/cache";
import { corsHeaders, readAllowedOrigins } from "@/lib/cors";
import { checkDemoGate, readDemoKey } from "@/lib/demoGate";
import {
  IncompleteDataError,
  InvalidAddressError,
  toHttpError,
  UnauthorizedError,
} from "@/lib/errors";
import { buildPropertyReport, type ReportDeps } from "@/lib/property/report";
import { RentcastError } from "@/lib/rentcast/client";
import { parsePropertyReport, type PropertyReport } from "@/lib/types";

/** How long a cached report is served before Rentcast is asked again. */
export const REPORT_CACHE_TTL_SECONDS = 86_400;
/** Bump the version to invalidate every cached report after a shape change. */
export const REPORT_CACHE_PREFIX = "report:v1:";
/** A slow cache must not eat the request's time budget. */
const CACHE_TIMEOUT_MS = 1_500;

export type HandlerDeps = ReportDeps & {
  /** Receives one short line per event. Never a body, header, key, or address. */
  log?: (line: string) => void;
  /** Demo gate key. Omitted: read from env. null: gate explicitly off. */
  demoKey?: string | null;
  /** Allowed CORS origins. Omitted: read from env. */
  allowedOrigins?: string[];
  /** Report cache. Omitted: the process-wide default. */
  cache?: ReportCache;
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

export function reportCacheKey(address: string): string {
  return REPORT_CACHE_PREFIX + normalizeAddressKey(address);
}

/** A log line that is safe by construction: no upstream text, URLs, or headers. */
function describe(err: unknown): string {
  if (err instanceof RentcastError) return err.message; // "rentcast <endpoint> <status|kind> <code>"
  if (err instanceof IncompleteDataError) return err.message; // names missing fields only
  if (err instanceof UnauthorizedError) return "property unauthorized";
  return `property ${err instanceof Error ? err.name : "unknown"}`;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("cache timeout")), CACHE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A cached report, or undefined on a miss. Failures and bad entries count as misses. */
async function readCachedReport(
  cache: ReportCache,
  key: string,
  log: (line: string) => void,
): Promise<PropertyReport | undefined> {
  let raw: string | null;
  try {
    raw = await withTimeout(cache.get(key));
  } catch {
    log("cache read failed");
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    return parsePropertyReport(JSON.parse(raw));
  } catch {
    log("cache entry invalid");
    return undefined;
  }
}

async function writeCachedReport(
  cache: ReportCache,
  key: string,
  report: PropertyReport,
  log: (line: string) => void,
): Promise<void> {
  try {
    await withTimeout(cache.set(key, JSON.stringify(report), REPORT_CACHE_TTL_SECONDS));
  } catch {
    log("cache write failed");
  }
}

export async function handlePropertyRequest(
  request: Request,
  deps: HandlerDeps = {},
): Promise<Response> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const cors = corsHeaders(request.headers.get("Origin"), deps.allowedOrigins ?? readAllowedOrigins());
  const respond = (body: unknown, status: number, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", ...cors, ...extra } });

  try {
    checkDemoGate(request, deps.demoKey === undefined ? readDemoKey() : (deps.demoKey ?? undefined));
    const address = parseAddress(new URL(request.url).searchParams.get("address"));

    const cache = deps.cache ?? getDefaultCache(log);
    const key = reportCacheKey(address);
    const cached = await readCachedReport(cache, key, log);
    if (cached) return respond(cached, 200, { "X-Cache": "HIT" });

    // Check our own output against the shared contract before sending or caching it.
    const report = parsePropertyReport(await buildPropertyReport(address, deps));
    await writeCachedReport(cache, key, report, log); // only successful reports are cached
    return respond(report, 200, { "X-Cache": "MISS" });
  } catch (err) {
    const { status, body } = toHttpError(err);
    if (!(err instanceof InvalidAddressError)) log(describe(err));
    return respond(body, status);
  }
}
