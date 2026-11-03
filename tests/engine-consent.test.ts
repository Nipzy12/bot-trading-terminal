import { describe, expect, it } from "vitest";
import { engineLivePermission, liveConsentSchema } from "../server/engine";
describe("Engine Exness laptop permission: default deny", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  it("requires two explicit acknowledgements", () => {
    expect(liveConsentSchema.safeParse({readOnlyKeyConfirmed:true}).success).toBe(false);
    expect(liveConsentSchema.safeParse({readOnlyKeyConfirmed:true,temporaryApiIdentifierAcknowledged:false}).success).toBe(false);
    expect(liveConsentSchema.safeParse({readOnlyKeyConfirmed:true,temporaryApiIdentifierAcknowledged:true}).success).toBe(true);
    expect(liveConsentSchema.safeParse({readOnlyKeyConfirmed:true,temporaryApiIdentifierAcknowledged:true,liveTrading:true}).success).toBe(false);
  });
  it("denies absent, invalid and expired grants", () => {
    expect(engineLivePermission(null, now)).toBe(false);
    expect(engineLivePermission("bad", now)).toBe(false);
    expect(engineLivePermission(new Date(now).toISOString(), now)).toBe(false);
    expect(engineLivePermission(new Date(now-1).toISOString(), now)).toBe(false);
  });
  it("accepts only bounded 30-minute permission", () => {
    expect(engineLivePermission(new Date(now+5*60*1000).toISOString(), now)).toBe(true);
    expect(engineLivePermission(new Date(now+30*60*1000).toISOString(), now)).toBe(true);
    expect(engineLivePermission(new Date(now+30*60*1000+1).toISOString(), now)).toBe(false);
  });
});
