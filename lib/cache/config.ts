// Upstash connection config: the ONE place that knows the env var names.
//
// Two name pairs are accepted, in this order:
//   1. UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (our own names)
//   2. KV_REST_API_URL + KV_REST_API_TOKEN                (set by Vercel's Upstash integration)
// The url and token always come from the SAME pair; a half pair is ignored rather
// than completed from the other pair. KV_REST_API_READ_ONLY_TOKEN is never used
// (the cache and the call-budget counter both need writes), and the KV_URL /
// REDIS_URL connection strings are for TCP clients, not this REST client.
// Values are returned to the caller only; nothing here logs.

export const UPSTASH_ENV_PAIRS = [
  { source: "upstash", url: "UPSTASH_REDIS_REST_URL", token: "UPSTASH_REDIS_REST_TOKEN" },
  { source: "kv", url: "KV_REST_API_URL", token: "KV_REST_API_TOKEN" },
] as const;

/** Named so tests can assert it is ignored; never read by resolveUpstashConfig. */
export const KV_READ_ONLY_TOKEN_ENV = "KV_REST_API_READ_ONLY_TOKEN";

/** Other integration variables that are deliberately ignored (also never read). */
export const IGNORED_UPSTASH_ENV = [KV_READ_ONLY_TOKEN_ENV, "KV_URL", "REDIS_URL"] as const;

export type UpstashConfig = {
  url: string;
  token: string;
  /** Which pair supplied the values. Not a secret, but not logged either. */
  source: (typeof UPSTASH_ENV_PAIRS)[number]["source"];
};

/** The first pair with both values non-blank, or undefined when neither pair is complete. */
export function resolveUpstashConfig(
  env: Record<string, string | undefined> = process.env,
): UpstashConfig | undefined {
  for (const pair of UPSTASH_ENV_PAIRS) {
    const url = env[pair.url]?.trim();
    const token = env[pair.token]?.trim();
    if (url && token) return { url, token, source: pair.source };
  }
  return undefined;
}
