// Report cache: a tiny string key/value store with expiry.
//
// Upstash Redis is used when both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// are set (the token is a secret: never logged). Otherwise an in-memory Map is used,
// which is per-process only (on Vercel, each warm instance has its own).

import { Redis } from "@upstash/redis";

export type ReportCache = {
  /** True when every server instance sees the same data (Upstash), false for in-memory. */
  readonly shared: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Atomically adds `amount` to a counter and returns the new total. The expiry is
   * set when the counter is first created and is not extended by later increments.
   */
  incrBy(key: string, amount: number, ttlSeconds: number): Promise<number>;
};

/** A slow store must not eat the request's time budget. */
export const CACHE_TIMEOUT_MS = 1_500;

/** Rejects if `promise` doesn't settle within CACHE_TIMEOUT_MS. */
export function withCacheTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("cache timeout")), CACHE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Env var names, exported so tests can reference them without repeating them. */
export const UPSTASH_ENV = {
  url: "UPSTASH_REDIS_REST_URL",
  token: "UPSTASH_REDIS_REST_TOKEN",
} as const;

// ---------------------------------------------------------------------------
// In-memory implementation

export class MemoryCache implements ReportCache {
  readonly shared = false;
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async incrBy(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const current = await this.get(key); // null when missing or expired
    if (current === null) {
      await this.set(key, String(amount), ttlSeconds);
      return amount;
    }
    const entry = this.entries.get(key) as { value: string; expiresAt: number };
    const total = Number(current) + amount;
    entry.value = String(total); // keep the original expiry
    return total;
  }
}

// ---------------------------------------------------------------------------
// Upstash implementation

/** The Upstash client methods we use; injectable so tests can fake them. */
export type UpstashLikeClient = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export class UpstashCache implements ReportCache {
  readonly shared = true;

  constructor(private readonly client: UpstashLikeClient) {}

  async incrBy(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const total = await this.client.incrby(key, amount);
    // INCRBY creates a missing key at 0; total === amount means we just created it.
    if (total === amount) await this.client.expire(key, ttlSeconds);
    return total;
  }

  async get(key: string): Promise<string | null> {
    const value = await this.client.get(key);
    if (value === null || value === undefined) return null;
    // The client is created without automatic JSON deserialization, so values
    // come back as strings; re-serialize defensively if one doesn't.
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, { ex: ttlSeconds });
  }
}

// ---------------------------------------------------------------------------
// Selection

export type CreateCacheOptions = {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  createUpstashClient?: () => UpstashLikeClient;
};

function defaultUpstashClient(): UpstashLikeClient {
  // Redis.fromEnv() reads the URL and token itself. Values stay strings, and one
  // retry keeps a cache outage from stalling a request.
  return Redis.fromEnv({ automaticDeserialization: false, retry: { retries: 1 } });
}

/** Picks Upstash when configured, otherwise in-memory. Logs one safe line. */
export function createCache(options: CreateCacheOptions = {}): ReportCache {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  if (env[UPSTASH_ENV.url]?.trim() && env[UPSTASH_ENV.token]?.trim()) {
    log("cache: upstash");
    return new UpstashCache((options.createUpstashClient ?? defaultUpstashClient)());
  }
  log("cache: in-memory");
  return new MemoryCache();
}

let defaultCache: ReportCache | undefined;

/** The process-wide cache, created (and logged) on first use. */
export function getDefaultCache(log?: (line: string) => void): ReportCache {
  defaultCache ??= createCache({ log });
  return defaultCache;
}
