// Upstash config resolution: which env var pair is used, and when none is.
// Fake values only. process.env is snapshotted before and restored after every test.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createCache, MemoryCache, UpstashCache, type UpstashLikeClient } from "@/lib/cache";
import {
  IGNORED_UPSTASH_ENV,
  KV_READ_ONLY_TOKEN_ENV,
  resolveUpstashConfig,
  UPSTASH_ENV_PAIRS,
  type UpstashConfig,
} from "@/lib/cache/config";

const [OWN, KV] = UPSTASH_ENV_PAIRS;
const ALL_NAMES = [OWN.url, OWN.token, KV.url, KV.token, ...IGNORED_UPSTASH_ENV];

const FAKE = {
  ownUrl: "https://own-fake.example.io",
  ownToken: "own-token-sentinel-3d9f",
  kvUrl: "https://kv-fake.example.io",
  kvToken: "kv-token-sentinel-8a21",
  readOnly: "read-only-token-sentinel-55c0",
};

let snapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  snapshot = { ...process.env };
  for (const name of ALL_NAMES) delete process.env[name]; // start from "nothing set"
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot)) delete process.env[name];
  }
  Object.assign(process.env, snapshot);
});

function setEnv(values: Record<string, string>) {
  Object.assign(process.env, values);
}

describe("resolveUpstashConfig (process.env)", () => {
  test("own names win when both pairs are set", () => {
    setEnv({ [OWN.url]: FAKE.ownUrl, [OWN.token]: FAKE.ownToken, [KV.url]: FAKE.kvUrl, [KV.token]: FAKE.kvToken });
    assert.deepEqual(resolveUpstashConfig(), { url: FAKE.ownUrl, token: FAKE.ownToken, source: "upstash" });
  });

  test("KV pair is used when it is the only one set", () => {
    setEnv({ [KV.url]: FAKE.kvUrl, [KV.token]: FAKE.kvToken });
    assert.deepEqual(resolveUpstashConfig(), { url: FAKE.kvUrl, token: FAKE.kvToken, source: "kv" });
  });

  test("a half pair counts as not configured (either pair, either half)", () => {
    const halves: Record<string, string>[] = [
      { [OWN.url]: FAKE.ownUrl },
      { [OWN.token]: FAKE.ownToken },
      { [KV.url]: FAKE.kvUrl },
      { [KV.token]: FAKE.kvToken },
    ];
    for (const half of halves) {
      for (const name of ALL_NAMES) delete process.env[name];
      setEnv(half);
      assert.equal(resolveUpstashConfig(), undefined, JSON.stringify(Object.keys(half)));
    }
  });

  test("halves of different pairs are never combined", () => {
    setEnv({ [OWN.url]: FAKE.ownUrl, [KV.token]: FAKE.kvToken });
    assert.equal(resolveUpstashConfig(), undefined);
    for (const name of ALL_NAMES) delete process.env[name];
    setEnv({ [KV.url]: FAKE.kvUrl, [OWN.token]: FAKE.ownToken });
    assert.equal(resolveUpstashConfig(), undefined);
  });

  test("a half own pair falls through to a complete KV pair", () => {
    setEnv({ [OWN.url]: FAKE.ownUrl, [KV.url]: FAKE.kvUrl, [KV.token]: FAKE.kvToken });
    assert.deepEqual(resolveUpstashConfig(), { url: FAKE.kvUrl, token: FAKE.kvToken, source: "kv" });
  });

  test("the read-only token alone (or with the KV url) counts as not configured", () => {
    setEnv({ [KV_READ_ONLY_TOKEN_ENV]: FAKE.readOnly });
    assert.equal(resolveUpstashConfig(), undefined);
    setEnv({ [KV.url]: FAKE.kvUrl });
    assert.equal(resolveUpstashConfig(), undefined);
  });

  test("the other integration variables are ignored", () => {
    setEnv(Object.fromEntries(IGNORED_UPSTASH_ENV.map((name) => [name, "redis://ignored-fake.example.io"])));
    assert.equal(resolveUpstashConfig(), undefined);
  });

  test("nothing set gives undefined", () => {
    assert.equal(resolveUpstashConfig(), undefined);
  });

  test("blank or whitespace-only values count as unset; values are trimmed", () => {
    setEnv({ [OWN.url]: "  ", [OWN.token]: FAKE.ownToken });
    assert.equal(resolveUpstashConfig(), undefined);
    setEnv({ [OWN.url]: ` ${FAKE.ownUrl} `, [OWN.token]: ` ${FAKE.ownToken}\n` });
    assert.deepEqual(resolveUpstashConfig(), { url: FAKE.ownUrl, token: FAKE.ownToken, source: "upstash" });
  });
});

describe("createCache selection uses the resolved pair", () => {
  const client: UpstashLikeClient = {
    get: async () => null,
    set: async () => "OK",
    incrby: async () => 0,
    expire: async () => 1,
  };

  test("KV pair selects Upstash; the client gets exactly the KV values; logs stay clean", () => {
    setEnv({ [KV.url]: FAKE.kvUrl, [KV.token]: FAKE.kvToken });
    const logs: string[] = [];
    const received: UpstashConfig[] = [];
    const cache = createCache({
      log: (l) => logs.push(l),
      createUpstashClient: (config) => {
        received.push(config);
        return client;
      },
    });
    assert.ok(cache instanceof UpstashCache);
    assert.equal(cache.shared, true);
    assert.deepEqual(received, [{ url: FAKE.kvUrl, token: FAKE.kvToken, source: "kv" }]);
    assert.deepEqual(logs, ["cache: upstash"]);
    assert.ok(!logs.some((l) => Object.values(FAKE).some((v) => l.includes(v)) || l.includes("kv")));
  });

  test("a half pair or read-only token alone selects in-memory (not shared)", () => {
    const envs: Record<string, string>[] = [
      { [KV.url]: FAKE.kvUrl },
      { [KV_READ_ONLY_TOKEN_ENV]: FAKE.readOnly, [KV.url]: FAKE.kvUrl },
    ];
    for (const env of envs) {
      for (const name of ALL_NAMES) delete process.env[name];
      setEnv(env);
      const logs: string[] = [];
      const cache = createCache({ log: (l) => logs.push(l), createUpstashClient: () => assert.fail("must not build a client") });
      assert.ok(cache instanceof MemoryCache);
      assert.equal(cache.shared, false);
      assert.deepEqual(logs, ["cache: in-memory"]);
    }
  });
});
