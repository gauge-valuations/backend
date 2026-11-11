// Demo gate for /api/property.
//
// When the DEMO_KEY env var is set, requests must send a matching X-Demo-Key header.
// This is a speed bump to protect the Rentcast request quota, NOT a secret: the
// matching value ships in the mobile app's bundle. When it is unset, the gate is off.
// Neither the configured value nor the header value is ever logged or returned.

import { createHash, timingSafeEqual } from "node:crypto";

import { UnauthorizedError } from "@/lib/errors";

export const DEMO_KEY_HEADER = "X-Demo-Key";

export function readDemoKey(): string | undefined {
  const value = process.env.DEMO_KEY?.trim();
  return value ? value : undefined;
}

/**
 * Constant-time comparison. Both sides are hashed to 32 bytes first, so
 * timingSafeEqual always gets equal-length buffers and a length mismatch leaks
 * nothing about the expected value's length.
 */
export function demoKeyMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Throws UnauthorizedError unless the gate is off or the header matches. */
export function checkDemoGate(request: Request, expected: string | undefined): void {
  if (expected === undefined) return;
  if (!demoKeyMatches(request.headers.get(DEMO_KEY_HEADER), expected)) {
    throw new UnauthorizedError();
  }
}
