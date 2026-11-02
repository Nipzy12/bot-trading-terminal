import { it, expect } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { ExnessReader } from "../server/exness";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const bucket = { limit: 10, window_seconds: 60, burst: 10 };
function reader(mode = "enabled", legacy = false) {
  const transport: typeof fetch = async (input, init) => {
    const u = new URL(String(input)),
      headers = init!.headers as Record<string, string>,
      bytes = Buffer.from(headers["EXN-DATA"], "base64url");
    expect(
      verify(
        null,
        bytes,
        publicKey,
        Buffer.from(headers["EXN-SIGN"], "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(bytes.toString())).toMatchObject({
      method: "GET",
      path: u.pathname + u.search,
    });
    if (u.pathname.endsWith("access-point"))
      return Response.json({
        account_id: "123456",
        access_point: "https://ap.exness.test",
      });
    if (u.pathname.endsWith("/account"))
      return Response.json({
        account_id: "123456",
        create_date: "2024-03-14T11:46:30+00:00",
        ...(legacy
          ? { trade_mode: mode }
          : {
              settings: {
                currency: "USD",
                leverage: "100",
                account_status: "active",
                execution_mode: "market",
                trade_mode: mode,
              },
            }),
      });
    if (u.pathname.endsWith("/instruments"))
      return Response.json({ instruments: ["XAUUSDm"] });
    return Response.json({
      limits: {
        rest: { global_account_rate: bucket, methods: [] },
        websocket: {
          global_account_limits: {
            max_active_connections: 1,
            max_inbound_message_bytes: 2048,
            connection_rate: bucket,
            inbound_message_rate: bucket,
          },
          endpoints: [
            {
              api_operation_id: "getWSTicks",
              connection_rate: bucket,
              inbound_message_rate: bucket,
              subscription_operation_rate: { ticks: bucket },
            },
          ],
        },
      },
    });
  };
  return new ExnessReader(
    {
      accountId: "123456",
      apiKey: "synthetic",
      privateKey: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      gateway: "https://gateway.exness.test",
    },
    transport,
  );
}
it("accepts official nested account settings and prepares a read-only tick handshake", async () => {
  const p = await reader().prepareLive("XAUUSD");
  expect(p.instrument).toBe("XAUUSDm");
  expect(p.path).toBe("/v1/server-events/accounts/123456/ws/ticks");
  expect(p.rules).toHaveLength(5);
});
it("rejects disabled trade mode without changing permissions", async () => {
  await expect(
    reader("trading_disabled").prepareLive("XAUUSD"),
  ).rejects.toMatchObject({ code: "ACCOUNT_TRADE_MODE_DISABLED", status: 403 });
});
it("rejects missing nested settings and unknown modes", async () => {
  await expect(
    reader("enabled", true).prepareLive("XAUUSD"),
  ).rejects.toMatchObject({ code: "BOOTSTRAP_FAILED" });
  await expect(
    reader("full_access").prepareLive("XAUUSD"),
  ).rejects.toMatchObject({ code: "BOOTSTRAP_FAILED" });
});
