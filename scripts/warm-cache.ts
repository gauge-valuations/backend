// Pre-loads the report cache for the pinned sample addresses on a deployed backend.
//
// Usage:
//   node --env-file=.env.local scripts/warm-cache.ts
//
// Reads BASE_URL (the deployed backend, e.g. https://gauge-backend.vercel.app) and,
// if set, DEMO_KEY (sent as X-Demo-Key). Prints only: address, HTTP status, X-Cache.
// Never prints the key, headers, or response bodies. Each MISS spends one report's
// worth of Rentcast calls (4) from the monthly budget; a HIT costs nothing.

import { PINNED_ADDRESSES } from "../lib/pinnedAddresses.ts";

const REQUEST_TIMEOUT_MS = 20_000;

function fail(message: string): never {
  console.error(`warm-cache: ${message}`);
  process.exit(1);
}

/** https://..., or http://localhost[:port] for local checks. Trailing slashes trimmed. */
function readBaseUrl(): string {
  const raw = process.env.BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  if (raw === "") fail("BASE_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("BASE_URL is not a valid URL");
  }
  const isHttps = url.protocol === "https:";
  const isLocal = url.protocol === "http:" && url.hostname === "localhost";
  if (!isHttps && !isLocal) fail("BASE_URL must be https:// (or http://localhost)");
  return raw;
}

async function warm(baseUrl: string, address: string, demoKey: string | undefined): Promise<boolean> {
  const url = `${baseUrl}/api/property?address=${encodeURIComponent(address)}`;
  const headers: Record<string, string> = {};
  if (demoKey) headers["X-Demo-Key"] = demoKey;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await res.body?.cancel(); // never read or print the body
    console.log(`${address}  HTTP ${res.status}  X-Cache ${res.headers.get("x-cache") ?? "-"}`);
    return res.status === 200;
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "request failed";
    console.log(`${address}  ${reason}`);
    return false;
  }
}

async function main(): Promise<void> {
  const baseUrl = readBaseUrl();
  const demoKey = process.env.DEMO_KEY?.trim() || undefined;
  let allOk = true;
  for (const address of PINNED_ADDRESSES) {
    allOk = (await warm(baseUrl, address, demoKey)) && allOk;
  }
  if (!allOk) process.exit(1);
}

await main();
