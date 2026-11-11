import { preflightResponse, readAllowedOrigins } from "@/lib/cors";
import { handlePropertyRequest } from "@/lib/property/handler";

// Pairs with the mobile app's 15s client timeout -- change both together.
// The Rentcast calls share a 12s deadline (lib/property/report.ts) so errors land first.
export const maxDuration = 15;

export function GET(request: Request) {
  return handlePropertyRequest(request);
}

// Browser CORS preflight for the web build. Not gated by the demo key.
export function OPTIONS(request: Request) {
  return preflightResponse(request, readAllowedOrigins());
}
