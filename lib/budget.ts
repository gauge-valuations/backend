// Monthly Rentcast call budget: a hard cap so a public link can't run up a bill.
//
// The Developer plan bills $0.20 per call beyond its included amount. Every cache
// MISS reserves 4 calls (one report = 4 Rentcast calls) on a counter BEFORE any call
// is made; if the new total exceeds MONTHLY_CALL_BUDGET the request gets a 402 and
// Rentcast is never called. Reservations are not refunded when a call fails, so the
// counter is a conservative upper bound.
//
// The counter resets with Rentcast's billing period, which starts on BILLING_DAY
// (1-28, UTC) each month. If the counter store is unavailable -- or isn't shared
// across instances in production -- the check fails CLOSED: no money is spent
// because a safety check couldn't run.

import { withCacheTimeout, type ReportCache } from "@/lib/cache";

export const CALLS_PER_REPORT = 4;
export const DEFAULT_CALL_BUDGET = 40;
/** The one safe log line for an invalid budget setting. */
export const INVALID_BUDGET_LOG = `invalid MONTHLY_CALL_BUDGET, using ${DEFAULT_CALL_BUDGET}`;
export const DEFAULT_BILLING_DAY = 1;
/** Longer than any billing period, so a counter outlives the period it counts. */
export const BUDGET_KEY_TTL_SECONDS = 40 * 86_400;

export type BudgetSettings = { budget: number; billingDay: number };

/** A positive integer; blank -> default; invalid -> default plus one safe log line. */
export function parseCallBudget(raw: string | undefined, log: (line: string) => void): number {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_CALL_BUDGET;
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value);
  log(INVALID_BUDGET_LOG);
  return DEFAULT_CALL_BUDGET;
}

/** An integer 1-28; blank or invalid -> 1 plus one safe log line. */
export function parseBillingDay(raw: string | undefined, log: (line: string) => void): number {
  const value = raw?.trim() ?? "";
  if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 28) return Number(value);
  log("invalid BILLING_DAY");
  return DEFAULT_BILLING_DAY;
}

let settingsFromEnv: BudgetSettings | undefined;

/** Reads both env vars once per process, so an invalid value logs once. */
export function readBudgetSettings(log: (line: string) => void): BudgetSettings {
  settingsFromEnv ??= {
    budget: parseCallBudget(process.env.MONTHLY_CALL_BUDGET, log),
    billingDay: parseBillingDay(process.env.BILLING_DAY, log),
  };
  return settingsFromEnv;
}

/**
 * Counter key for the billing period containing `now`: "budget:rentcast:YYYY-MM",
 * where YYYY-MM is the month the CURRENT period started. On or after the billing
 * day it started this month; before it, last month (January -> previous December).
 */
export function billingPeriodKey(now: Date, billingDay: number): string {
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-11
  if (now.getUTCDate() < billingDay) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `budget:rentcast:${year}-${String(month + 1).padStart(2, "0")}`;
}

export type BudgetOutcome = "ok" | "exceeded" | "store_failed" | "not_shared";

/** Reserves one report's worth of calls. Anything but "ok" means: do not call Rentcast. */
export async function reserveReportCalls(
  store: ReportCache,
  settings: BudgetSettings,
  now: Date,
  requireSharedCounter: boolean,
): Promise<BudgetOutcome> {
  // A per-instance counter resets on every cold start: not a real cap in production.
  if (requireSharedCounter && !store.shared) return "not_shared";
  let total: number;
  try {
    total = await withCacheTimeout(
      store.incrBy(billingPeriodKey(now, settings.billingDay), CALLS_PER_REPORT, BUDGET_KEY_TTL_SECONDS),
    );
  } catch {
    return "store_failed";
  }
  if (!Number.isFinite(total)) return "store_failed";
  return total > settings.budget ? "exceeded" : "ok";
}
