import { it, expect } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { ExnessReader } from "../server/exness";
import {
  brokerState,
  decimalUnits,
  formatBrokerDecimal,
} from "../src/broker-monitor";
const keys = generateKeyPairSync("ed25519");
function fixture(
  state: unknown = {
    balance: "12345.67",
    equity: "12000.01",
    used_margin: "100.25",
  },
  wrongAccount = false,
) {
  const paths: string[] = [];
  const reader = new ExnessReader(
    {
      accountId: "123456",
      apiKey: "synthetic",
      privateKey: keys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      gateway: "https://gateway.exness.test",
    },
    async (input, init) => {
      const u = new URL(String(input));
      paths.push(u.pathname);
      const headers = init!.headers as Record<string, string>,
        bytes = Buffer.from(headers["EXN-DATA"], "base64url");
      expect(init?.method).toBe("GET");
      expect(JSON.parse(bytes.toString()).path).toBe(u.pathname + u.search);
      expect(
        verify(
          null,
          bytes,
          keys.publicKey,
          Buffer.from(headers["EXN-SIGN"], "base64url"),
        ),
      ).toBe(true);
      if (u.pathname.endsWith("access-point"))
        return Response.json({
          account_id: "123456",
          access_point: "https://ap.exness.test",
        });
      if (u.pathname.endsWith("limits"))
        return Response.json({
          limits: {
            rest: {
              global_account_rate: { limit: 100, window_seconds: 60 },
              methods: [],
            },
          },
        });
      if (u.pathname.endsWith("account"))
        return Response.json({
          account_id: wrongAccount ? "999999" : "123456",
          create_date: "2024-01-01T00:00:00Z",
          settings: { currency: "USD" },
        });
      expect(u.pathname).toBe("/v1/trading/accounts/123456/snapshot");
      return Response.json({
        orders: [{ order_id: "must-not-return" }],
        positions: [{ position_id: "private-position" }],
        account_state: state,
      });
    },
  );
  return { reader, paths };
}
it("uses signed trading snapshot and returns only selected balance fields, deduplicating reads", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.reader.accountMonitor(),
    f.reader.accountMonitor(),
  ]);
  expect(a).toEqual(b);
  expect(await f.reader.accountMonitor()).toEqual(a);
  expect(Object.keys(a).sort()).toEqual([
    "asOf",
    "balance",
    "currency",
    "equity",
    "status",
    "used_margin",
  ]);
  expect(a.balance).toBe("12345.67");
  expect(f.paths.filter((p) => p.endsWith("snapshot"))).toHaveLength(1);
  for (const forbidden of [
    "must-not-return",
    "private-position",
    "123456",
    "synthetic",
  ])
    expect(JSON.stringify(a)).not.toContain(forbidden);
  expect(f.paths.some((p) => p.includes("/balance"))).toBe(false);
});
it.each([
  12345,
  "NaN",
  "1e5",
  " 10.00",
  "01.00",
  "1,000.00",
  "Infinity",
  "1.1234567890123456789",
])("rejects invalid decimal %s", async (balance) => {
  await expect(
    fixture({ balance, equity: "1", used_margin: "0" }).reader.accountMonitor(),
  ).rejects.toMatchObject({ code: "EXNESS_INVALID_RESPONSE" });
});
it("preserves exact decimal arithmetic and formatting beyond IEEE-754", () => {
  expect(decimalUnits("0.1") + decimalUnits("0.2")).toBe(decimalUnits("0.3"));
  expect(formatBrokerDecimal("9007199254740993.123456789012345678")).toBe(
    "9,007,199,254,740,993.123456789012345678",
  );
  expect(
    brokerState.safeParse({ balance: "-1.01", equity: "-2", used_margin: "0" })
      .success,
  ).toBe(true);
  expect(
    brokerState.safeParse({ balance: "1", equity: "1", used_margin: "-0.01" })
      .success,
  ).toBe(false);
});
it("fails mismatched account details without reading the snapshot", async () => {
  const f = fixture(undefined, true);
  await expect(f.reader.accountMonitor()).rejects.toMatchObject({
    code: "EXNESS_INVALID_RESPONSE",
  });
  expect(f.paths.some((p) => p.endsWith("snapshot"))).toBe(false);
});
