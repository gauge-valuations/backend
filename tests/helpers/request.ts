// Calls the /api/property handler offline with safe test defaults: a fake fetch,
// the sentinel Rentcast key, a FRESH in-memory cache (so tests never share hits),
// the demo gate off, CORS off, and a generous call budget that doesn't require a
// shared counter. Each can be overridden per test.

import { MemoryCache } from "@/lib/cache";
import { handlePropertyRequest, type HandlerDeps } from "@/lib/property/handler";

import { fakeFetch, SENTINEL_KEY, type Router } from "./fixtures";

export type CallResult = {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
  logs: string[];
  calls: string[];
};

export type CallOptions = {
  deps?: Partial<HandlerDeps>;
  headers?: Record<string, string>;
};

export async function callProperty(
  address: string | null,
  router: Router,
  options: CallOptions = {},
): Promise<CallResult> {
  const logs: string[] = [];
  const fetch = fakeFetch(router);
  const url = new URL("http://localhost/api/property");
  if (address !== null) url.searchParams.set("address", address);
  const res = await handlePropertyRequest(new Request(url, { headers: options.headers }), {
    fetch,
    apiKey: SENTINEL_KEY,
    log: (line) => logs.push(line),
    cache: new MemoryCache(),
    demoKey: null,
    allowedOrigins: [],
    budget: { budget: 1_000, billingDay: 1 },
    requireSharedCounter: false,
    ...options.deps,
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text, headers: res.headers, logs, calls: fetch.calls };
}

export function errorCode(r: CallResult): string | undefined {
  return (r.body as { error?: string }).error;
}
