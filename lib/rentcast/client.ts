// Minimal Rentcast HTTP client.
//
// This is the ONLY file that reads the API key from the environment. The key goes
// into the X-Api-Key request header and nowhere else: errors thrown from here carry
// only the endpoint path, HTTP status, and Rentcast's short error code -- never the
// key, headers, request URL (which contains the address), or response text.

import { stripNulls } from "@/lib/normalize/nulls";
import type { RentcastErrorBody } from "@/lib/rentcast/responses";

const BASE_URL = "https://api.rentcast.io/v1";

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export type RentcastErrorKind = "http" | "timeout" | "network" | "parse" | "config";

export class RentcastError extends Error {
  readonly endpoint: string;
  readonly kind: RentcastErrorKind;
  readonly status?: number;
  /** Rentcast's error code, e.g. "billing/subscription-inactive". Never the message. */
  readonly code?: string;

  constructor(endpoint: string, kind: RentcastErrorKind, status?: number, code?: string) {
    super(`rentcast ${endpoint} ${status ?? kind} ${code ?? "-"}`);
    this.name = "RentcastError";
    this.endpoint = endpoint;
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export type RentcastClientOptions = {
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Injectable for tests. Defaults to the environment variable. */
  apiKey?: string;
  /** Shared deadline for every call made through this client. */
  signal?: AbortSignal;
};

export type RentcastClient = {
  get<T>(endpoint: string, params: Record<string, string>): Promise<T>;
};

// Only accept short, code-like strings so nothing user- or key-derived is echoed.
const SAFE_CODE = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i;

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as RentcastErrorBody;
    const code = body?.error;
    return typeof code === "string" && code.length <= 64 && SAFE_CODE.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

export function createRentcastClient(options: RentcastClientOptions = {}): RentcastClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const signal = options.signal;

  async function get<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const apiKey = options.apiKey ?? process.env.RENTCAST_API_KEY;
    if (!apiKey) throw new RentcastError(endpoint, "config");

    const url = new URL(BASE_URL + endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: "application/json", "X-Api-Key": apiKey },
        signal,
      });
    } catch {
      throw new RentcastError(endpoint, signal?.aborted ? "timeout" : "network");
    }

    if (!res.ok) {
      const code = await readErrorCode(res);
      throw new RentcastError(endpoint, "http", res.status, code);
    }

    try {
      return stripNulls(await res.json()) as T;
    } catch {
      throw new RentcastError(endpoint, signal?.aborted ? "timeout" : "parse", res.status);
    }
  }

  return { get };
}
