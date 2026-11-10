// Capture one raw Rentcast response into fixtures/rentcast/raw/<name>.json.
//
// Usage:
//   node --env-file=.env.local scripts/capture-fixture.ts <name> <endpoint> key=value ...
//
// Never prints the API key, request headers, or the response body.
// Skips the call if the output file already exists, so re-runs never re-spend budget.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE_URL = "https://api.rentcast.io/v1";
const OUT_DIR = path.join("fixtures", "rentcast", "raw");

function fail(message: string): never {
  console.error(`capture-fixture: ${message}`);
  process.exit(1);
}

function isGitIgnored(file: string): boolean {
  try {
    // Exits 0 when ignored, 1 when not.
    execFileSync("git", ["check-ignore", "-q", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const [name, endpoint, ...pairs] = process.argv.slice(2);
  if (!name || !endpoint) {
    fail("usage: capture-fixture.ts <name> <endpoint> key=value ...");
  }
  if (!/^[\w-]+$/.test(name)) fail("name may only contain letters, digits, _ and -");
  if (!endpoint.startsWith("/")) fail("endpoint must start with /");

  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) fail(`bad param "${pair}", expected key=value`);
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const outFile = path.join(OUT_DIR, `${name}.json`);
  if (existsSync(outFile)) {
    console.log(`${name}: skipped (already exists) ${outFile}`);
    return;
  }

  const apiKey = process.env.RENTCAST_API_KEY;
  if (!apiKey) fail("RENTCAST_API_KEY is not set");

  if (!isGitIgnored(outFile)) fail(`${outFile} is not gitignored; refusing to call`);

  const url = new URL(BASE_URL + endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "X-Api-Key": apiKey },
    });
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const record = {
    name,
    endpoint,
    params,
    status: res.status,
    capturedAt: new Date().toISOString(),
    body,
  };
  writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");

  const billable = res.status === 200 ? "yes" : "no";
  console.log(`${name}: HTTP ${res.status}, billable ${billable}, ${outFile}`);
}

await main();
