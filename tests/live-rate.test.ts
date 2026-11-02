import { it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { ExnessReader } from "../server/exness";
import { rateInfo } from "../src/live-diagnostics";
it("labels broker REST 429 without inventing Retry-After", async () => {
  const key = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const r = new ExnessReader(
    {
      apiKey: "synthetic",
      privateKey: key,
      accountId: "123456",
      gateway: "https://gateway.exness.test",
    },
    async () => Response.json({ code: 3015 }, { status: 429 }),
  );
  for (let i = 0; i < 2; i++)
    await expect(r.prepareLive("XAUUSD")).rejects.toMatchObject({
      code: "EXNESS_RATE_LIMIT",
      retryAfter: undefined,
      details: { rateLimitSource: "EXNESS_REST" },
    });
});
it("only accepts safe source enums and known positive bounded retry seconds", () => {
  expect(
    rateInfo({ rateLimitSource: "EXNESS_WS", retryAfterSec: 3.1 }),
  ).toEqual({ rateLimitSource: "EXNESS_WS", retryAfterSec: 4 });
  expect(
    rateInfo({
      rateLimitSource: "private-account-host",
      retryAfterSec: -1,
      key: "secret",
    }),
  ).toEqual({});
  expect(rateInfo({ retryAfterSec: Infinity })).toEqual({});
});
