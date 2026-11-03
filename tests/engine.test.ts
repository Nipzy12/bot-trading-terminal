import { describe, expect, it } from "vitest";
import { engineSecretHash, enginePresence } from "../server/engine";

const key = "a".repeat(32);
describe("NEXUS Windows engine authentication helpers", () => {
  it("separates pairing and device token hash domains", () => {
    expect(engineSecretHash("pair", "abc", key)).not.toBe(engineSecretHash("device", "abc", key));
  });
  it("is deterministic for the same secret", () => {
    expect(engineSecretHash("pair", "abc", key)).toBe(engineSecretHash("pair", "abc", key));
  });
  it("rejects short secrets", () => {
    expect(() => engineSecretHash("pair", "abc", "short")).toThrow("ENGINE_AUTH_UNAVAILABLE");
  });
  it("shows offline without a verified heartbeat", () => {
    expect(enginePresence(null)).toBe("OFFLINE");
    expect(enginePresence("not-a-date")).toBe("OFFLINE");
  });
  it("stops showing online once a heartbeat exceeds 30 seconds", () => {
    const now = Date.parse("2026-11-03T00:00:45Z");
    expect(enginePresence("2026-11-03T00:00:20Z", now)).toBe("ONLINE");
    expect(enginePresence("2026-11-03T00:00:14Z", now)).toBe("OFFLINE");
    expect(enginePresence("2026-11-03T00:01:00Z", now)).toBe("OFFLINE");
  });
});
