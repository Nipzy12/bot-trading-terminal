import { describe, expect, it } from "vitest";
import { brokerProbePath, brokerProbeFlag, PROBE_RUN_SECONDS, PROBE_LEASE_SECONDS } from "../server/engine-broker";
describe("read-only signed broker probe constraints", () => {
 it("restricts the signed WebSocket path to one valid account", () => {
   expect(brokerProbePath("123456")).toBe("/v1/server-events/accounts/123456/ws/ticks");
   expect(() => brokerProbePath("123/orders")).toThrow();
   expect(() => brokerProbePath("0")).toThrow();
   expect(() => brokerProbePath("18446744073709551616")).toThrow();
 });
 it("requires explicit manual consent in the device request", () => {
   expect(brokerProbeFlag.safeParse({confirmTemporarySignedAccess: true}).success).toBe(true);
   expect(brokerProbeFlag.safeParse({}).success).toBe(false);
   expect(brokerProbeFlag.safeParse({confirmTemporarySignedAccess: true, trade: true}).success).toBe(false);
 });
 it("ends the probe before the shared lease expires", () => {
   expect(PROBE_RUN_SECONDS).toBeLessThan(PROBE_LEASE_SECONDS);
   expect(PROBE_RUN_SECONDS).toBeGreaterThan(25);
 });
});
