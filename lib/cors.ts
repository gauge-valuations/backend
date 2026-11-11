// CORS for the web build of the app. Native apps don't send Origin and are unaffected.
//
// ALLOWED_ORIGINS is a comma-separated list of exact origins. Only a listed origin is
// ever echoed back; there is no wildcard. When the list is unset, no CORS headers are
// sent at all. When it is set, responses always carry `Vary: Origin`, because their
// headers then depend on the caller's origin.

const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function readAllowedOrigins(): string[] {
  return parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
}

/** Headers to add to every /api/property response. */
export function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  if (allowedOrigins.length === 0) return {};
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Answers the browser's OPTIONS preflight. Never gated, never calls upstream. */
export function preflightResponse(request: Request, allowedOrigins: string[]): Response {
  const headers = corsHeaders(request.headers.get("Origin"), allowedOrigins);
  if (headers["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "X-Demo-Key";
    headers["Access-Control-Max-Age"] = String(PREFLIGHT_MAX_AGE_SECONDS);
  }
  return new Response(null, { status: 204, headers });
}
