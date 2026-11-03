import { describe, expect, it } from "vitest";
import { localConfigSchema, localTicksUrl, safeLocalBrokerOrigin, LOCAL_PROBE_LIMIT_MS,
  acceptLocalProbeFrame } from "../engine/local-probe-core";

describe("V6.2C local broker guardrails", () => {
  it("rejects internal hosts and spoofed Exness domains", () => {
    expect(() => safeLocalBrokerOrigin("https://localhost")).toThrow();
    expect(() => safeLocalBrokerOrigin("https://exness.com.evil.test")).toThrow();
    expect(() => safeLocalBrokerOrigin("http://ap.exness.com")).toThrow();
    expect(safeLocalBrokerOrigin("https://ap.exness.com")).toBe("https://ap.exness.com");
  });
  it("cannot swap the signed GET tick endpoint to an order endpoint", () => {
    expect(localTicksUrl("https://ap.exness.com",
      "/v1/server-events/accounts/123456/ws/ticks", "123456")).toBe(
        "wss://ap.exness.com/v1/server-events/accounts/123456/ws/ticks");
    expect(() => localTicksUrl("https://ap.exness.com",
      "/v1/trading/accounts/123456/orders", "123456")).toThrow();
    expect(() => localTicksUrl("https://ap.exness.com",
      "/v1/server-events/accounts/123456/ws/ticks", "567890")).toThrow();
  });
  it("requires an explicitly local Ed25519 hex secret and no extra fields", () => {
    const config = { apiKey: "exnsk-example-readonly", accountId:"123456",
      gateway:"https://gateway.exness.com", privateKey:"f".repeat(128) };
    expect(localConfigSchema.safeParse(config).success).toBe(true);
    expect(localConfigSchema.safeParse({...config, privateKey: "unsafe"}).success).toBe(false);
    expect(localConfigSchema.safeParse({...config, orders:true}).success).toBe(false);
  });
  it("bounds the whole probe duration", () => {
    expect(LOCAL_PROBE_LIMIT_MS).toBe(65_000);
  });
  it("never accepts a control error as a quote", () => {
    const context = { subscriptionId:"req", accountId:"123456",
      connectionId:"11111111-1111-4111-8111-111111111111", symbol:"XAUUSD",
      instrument:"XAUUSDm", last:0, now:Date.parse("2026-11-04T00:00:02Z") };
    const tick = { instrument:"XAUUSDm", bid:3947.12, ask:3947.42,
      timestamp:"2026-11-04T00:00:01Z" };
    expect(acceptLocalProbeFrame(tick, context).kind).toBe("tick");
    expect(acceptLocalProbeFrame({...tick, code:200}, context).kind).not.toBe("tick");
    expect(acceptLocalProbeFrame({...tick, timestamp:"yesterday"}, context).kind).not.toBe("tick");
    expect(acceptLocalProbeFrame({...tick, account_id:"other"}, context).kind).not.toBe("tick");
  });
});
