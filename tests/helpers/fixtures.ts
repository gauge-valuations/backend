// Offline test helpers: load the gitignored raw Rentcast captures and serve them
// through a fake fetch. No network, no real API key.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { FetchLike } from "@/lib/rentcast/client";

const RAW_DIR = path.join(process.cwd(), "fixtures", "rentcast", "raw");

export const FIXTURE_NAMES = [
  "00-error-subscription-inactive",
  "01-sale-austin-active",
  "02-avm-value-listed",
  "03-avm-rent-listed",
  "04-sale-listed",
  "05-markets",
  "06-avm-value-unlisted",
  "07-sale-unlisted",
  "08-avm-value-bad",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export type Fixture = { status: number; body: unknown };

/** Fake key used by every test; asserted never to leak into output. */
export const SENTINEL_KEY = "test-sentinel-key-9f2c1e";

export const LISTED_ADDRESS = "3901 Prentice Ln, Austin, TX 78746";
export const UNLISTED_ADDRESS = "3712 Meredith St, Austin, TX 78703";

/** The raw captures are gitignored, so tests that need them skip when absent. */
export const SKIP_NO_FIXTURES = FIXTURE_NAMES.every((n) => existsSync(path.join(RAW_DIR, `${n}.json`)))
  ? false
  : "raw fixtures not present in fixtures/rentcast/raw/";

export function loadFixture(name: FixtureName): Fixture {
  const record = JSON.parse(readFileSync(path.join(RAW_DIR, `${name}.json`), "utf8")) as Fixture;
  return { status: record.status, body: record.body };
}

/** The body of a 200 fixture, typed by the caller. */
export function fixtureBody<T>(name: FixtureName): T {
  return loadFixture(name).body as T;
}

export function jsonResponse(fixture: Fixture): Response {
  return new Response(JSON.stringify(fixture.body), {
    status: fixture.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Resolves an upstream call (endpoint path + query) to a canned response. */
export type Router = (endpoint: string, params: URLSearchParams) => Fixture | Error;

export type FakeFetch = FetchLike & { calls: string[] };

/**
 * A fake fetch that checks the key header and answers from `router`.
 * Returning an Error from the router makes fetch reject (a network failure).
 */
export function fakeFetch(router: Router): FakeFetch {
  const calls: string[] = [];
  const impl = async (input: URL, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (headers.get("X-Api-Key") !== SENTINEL_KEY) throw new Error("missing test key header");
    const endpoint = input.pathname.replace(/^\/v1/, "");
    calls.push(endpoint);
    const result = router(endpoint, input.searchParams);
    if (result instanceof Error) throw result;
    return jsonResponse(result);
  };
  return Object.assign(impl, { calls });
}

/** A fake fetch that never answers until the request is aborted. */
export function hangingFetch(): FetchLike {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

/**
 * The happy-path router for one address. Meredith St has no rent or markets
 * capture of its own, so it reuses Prentice Ln's rent (03) and the 78746 markets
 * capture (05); those tests only check listing and value behavior.
 */
export function addressRouter(overrides: Partial<Record<string, Fixture | Error>> = {}): Router {
  return (endpoint, params) => {
    if (endpoint in overrides) return overrides[endpoint] as Fixture | Error;
    const address = params.get("address");
    const unlisted = address === UNLISTED_ADDRESS;
    switch (endpoint) {
      case "/avm/value":
        return loadFixture(unlisted ? "06-avm-value-unlisted" : "02-avm-value-listed");
      case "/avm/rent/long-term":
        return loadFixture("03-avm-rent-listed");
      case "/listings/sale":
        return loadFixture(unlisted ? "07-sale-unlisted" : "04-sale-listed");
      case "/markets":
        return loadFixture("05-markets");
      default:
        return new Error(`unexpected endpoint ${endpoint}`);
    }
  };
}

/** Recursively collects the paths of any null values. */
export function findNulls(value: unknown, at = "$"): string[] {
  if (value === null) return [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => findNulls(v, `${at}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => findNulls(v, `${at}.${k}`));
  }
  return [];
}
