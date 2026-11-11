// Request handling for GET /api/property, kept out of route.ts so tests can call it
// with a fake fetch, a fake cache, and explicit gate/CORS/budget settings.
//
// Order: CORS headers -> demo gate -> address validation -> cache lookup ->
// [miss only] monthly budget reservation -> build report -> cache write.

import { normalizeAddressKey } from "@/lib/address";
import { readBudgetSettings, reserveReportCalls, type BudgetSettings } from "@/lib/budget";
import { getDefaultCache, withCacheTimeout, type ReportCache } from "@/lib/cache";
import { corsHeaders, readAllowedOrigins } from "@/lib/cors";
import { checkDemoGate, readDemoKey } from "@/lib/demoGate";
import {
  CallBudgetError,
  IncompleteDataError,
  InvalidAddressError,
  toHttpError,
  UnauthorizedError,
} from "@/lib/errors";
import { PINNED_ADDRESSES } from "@/lib/pinnedAddresses";
import { buildPropertyReport, type ReportDeps } from "@/lib/property/report";
import { RentcastError } from "@/lib/rentcast/client";
import { parsePropertyReport, type PropertyReport } from "@/lib/types";

/** How long a cached report is served before Rentcast is asked again. */
export const REPORT_CACHE_TTL_SECONDS = 86_400;
/** Pinned sample addresses are cached for 30 days. */
export const PINNED_CACHE_TTL_SECONDS = 2_592_000;
/** Bump the version to invalidate every cached report after a shape change. */
export const REPORT_CACHE_PREFIX = "report:v1:";

const PINNED_KEYS = new Set(PINNED_ADDRESSES.map(normalizeAddressKey));

export type HandlerDeps = ReportDeps & {
  /** Receives one short line per event. Never a body, header, key, or address. */
  log?: (line: string) => void;
  /** Demo gate key. Omitted: read from env. null: gate explicitly off. */
  demoKey?: string | null;
  /** Allowed CORS origins. Omitted: read from env. */
  allowedOrigins?: string[];
  /** Report cache and call-budget counter store. Omitted: the process-wide default. */
  cache?: ReportCache;
  /** Budget and billing day. Omitted: read from env. */
  budget?: BudgetSettings;
  /** Current time, for the billing period. Omitted: the real clock. */
  now?: () => Date;
  /** Refuse to spend unless the counter is shared. Omitted: true in production. */
  requireSharedCounter?: boolean;
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

/** 30 days for a pinned sample address (matched by normalized key), else 24 hours. */
export function reportCacheTtl(address: string): number {
  return PINNED_KEYS.has(normalizeAddressKey(address)) ? PINNED_CACHE_TTL_SECONDS : REPORT_CACHE_TTL_SECONDS;
}

/** A log line that is safe by construction: no upstream text, URLs, or headers. */
function describe(err: unknown): string {
  if (err instanceof RentcastError) return err.message; // "rentcast <endpoint> <status|kind> <code>"
  if (err instanceof IncompleteDataError) return err.message; // names missing fields only
  if (err instanceof CallBudgetError) return err.message; // fixed text
  if (err instanceof UnauthorizedError) return "property unauthorized";
  return `property ${err instanceof Error ? err.name : "unknown"}`;
}

/** A cached report, or undefined on a miss. Failures and bad entries count as misses. */
async function readCachedReport(
  cache: ReportCache,
  key: string,
  log: (line: string) => void,
): Promise<PropertyReport | undefined> {
  let raw: string | null;
  try {
    raw = await withCacheTimeout(cache.get(key));
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
  ttlSeconds: number,
  log: (line: string) => void,
): Promise<void> {
  try {
    await withCacheTimeout(cache.set(key, JSON.stringify(report), ttlSeconds));
  } catch {
    log("cache write failed");
  }
}

/** Throws CallBudgetError unless one report's calls could be reserved. */
async function reserveBudget(cache: ReportCache, deps: HandlerDeps, log: (line: string) => void) {
  const outcome = await reserveReportCalls(
    cache,
    deps.budget ?? readBudgetSettings(log),
    (deps.now ?? (() => new Date()))(),
    deps.requireSharedCounter ?? process.env.NODE_ENV === "production",
  );
  if (outcome === "exceeded") throw new CallBudgetError("monthly call budget reached");
  if (outcome === "store_failed") throw new CallBudgetError("budget check failed");
  if (outcome === "not_shared") throw new CallBudgetError("budget check failed: no shared counter");
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
    if (cached) return respond(cached, 200, { "X-Cache": "HIT" }); // hits never touch the budget

    await reserveBudget(cache, deps, log); // before ANY Rentcast call; never refunded

    // Check our own output against the shared contract before sending or caching it.
    const report = parsePropertyReport(await buildPropertyReport(address, deps));
    await writeCachedReport(cache, key, report, reportCacheTtl(address), log); // only successes
    return respond(report, 200, { "X-Cache": "MISS" });
  } catch (err) {
    const { status, body } = toHttpError(err);
    if (!(err instanceof InvalidAddressError)) log(describe(err));
    return respond(body, status);
  }
}
