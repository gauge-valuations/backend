// CORS: allowed origin, disallowed origin, unset list, preflight.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { corsHeaders, parseAllowedOrigins, preflightResponse } from "@/lib/cors";

import { addressRouter, LISTED_ADDRESS, SKIP_NO_FIXTURES } from "./helpers/fixtures";
import { callProperty } from "./helpers/request";

const WEB = "https://gauge-web.example.app";
const LOCAL = "http://localhost:8081";
const ALLOWED = [WEB, LOCAL];
const EVIL = "https://evil.example.com";

function preflight(origin: string | null, allowed: string[]): Response {
  const headers: Record<string, string> = {
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "x-demo-key",
  };
  if (origin) headers.Origin = origin;
  return preflightResponse(new Request("http://localhost/api/property", { method: "OPTIONS", headers }), allowed);
}

const corsKeys = (h: Headers) => [...h.keys()].filter((k) => k.startsWith("access-control-") || k === "vary");

describe("parseAllowedOrigins", () => {
  test("splits on commas, trims, drops blanks", () => {
    assert.deepEqual(parseAllowedOrigins(` ${WEB} ,, ${LOCAL} ,`), ALLOWED);
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins("  "), []);
  });
});

describe("corsHeaders", () => {
  test("allowed origin is echoed exactly, with Vary", () => {
    assert.deepEqual(corsHeaders(WEB, ALLOWED), { Vary: "Origin", "Access-Control-Allow-Origin": WEB });
  });
  test("disallowed origin: Vary only, no Allow-Origin", () => {
    assert.deepEqual(corsHeaders(EVIL, ALLOWED), { Vary: "Origin" });
    assert.deepEqual(corsHeaders(WEB + "/", ALLOWED), { Vary: "Origin" }, "exact match only");
    assert.deepEqual(corsHeaders(null, ALLOWED), { Vary: "Origin" });
  });
  test("unset list: nothing at all", () => {
    assert.deepEqual(corsHeaders(WEB, []), {});
  });
});

describe("preflight (OPTIONS)", () => {
  test("allowed origin gets the full set", () => {
    const res = preflight(WEB, ALLOWED);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), WEB);
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, OPTIONS");
    assert.equal(res.headers.get("access-control-allow-headers"), "X-Demo-Key");
    assert.equal(res.headers.get("access-control-max-age"), "86400");
    assert.equal(res.headers.get("vary"), "Origin");
  });
  test("disallowed origin: bare 204 with Vary only", () => {
    const res = preflight(EVIL, ALLOWED);
    assert.equal(res.status, 204);
    assert.deepEqual(corsKeys(res.headers), ["vary"]);
  });
  test("unset list: bare 204, no CORS headers", () => {
    const res = preflight(WEB, []);
    assert.equal(res.status, 204);
    assert.deepEqual(corsKeys(res.headers), []);
  });
});

describe("CORS on /api/property responses", { skip: SKIP_NO_FIXTURES }, () => {
  test("200 from an allowed origin carries Allow-Origin + Vary", async () => {
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { headers: { Origin: WEB }, deps: { allowedOrigins: ALLOWED } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), WEB);
    assert.equal(r.headers.get("vary"), "Origin");
  });
  test("errors from an allowed origin carry them too (400 and gate 401)", async () => {
    const bad = await callProperty("ab", addressRouter(), { headers: { Origin: WEB }, deps: { allowedOrigins: ALLOWED } });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("access-control-allow-origin"), WEB);
    const gated = await callProperty(LISTED_ADDRESS, addressRouter(), {
      headers: { Origin: WEB },
      deps: { allowedOrigins: ALLOWED, demoKey: "some-demo-value" },
    });
    assert.equal(gated.status, 401);
    assert.equal(gated.headers.get("access-control-allow-origin"), WEB);
  });
  test("disallowed origin gets no Allow-Origin", async () => {
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { headers: { Origin: EVIL }, deps: { allowedOrigins: ALLOWED } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
  test("unset list: no CORS headers at all", async () => {
    const r = await callProperty(LISTED_ADDRESS, addressRouter(), { headers: { Origin: WEB } });
    assert.deepEqual(corsKeys(r.headers), []);
  });
});
