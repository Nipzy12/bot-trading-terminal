import { describe, expect, it } from "vitest";
import { validateRelayTest, relayTestFresh } from "../server/engine";
const now = Date.parse("2026-11-04T00:00:00Z");
const quote = { mode: "TEST_ONLY", symbol: "XAUUSD", bid: 2742.68,
 ask: 2742.92, at: "2026-11-04T00:00:00.000Z" };
describe("isolated engine TEST_ONLY quote transport", () => {
 it("allows a fresh finite synthetic fixture", () => {
   expect(validateRelayTest(quote, now)).toEqual(quote);
 });
 it("rejects externally claimed EXNESS_LIVE provenance", () => {
   expect(validateRelayTest({ ...quote, mode:"EXNESS_LIVE" }, now)).toBeNull();
 });
 it("rejects inverted or zero quotes", () => {
   expect(validateRelayTest({ ...quote, ask: 1 }, now)).toBeNull();
   expect(validateRelayTest({ ...quote, bid: 0 }, now)).toBeNull();
 });
 it("rejects extra or unsupported symbols", () => {
   expect(validateRelayTest({ ...quote, symbol:"EURUSD" }, now)).toBeNull();
   expect(validateRelayTest({ ...quote, debug:true }, now)).toBeNull();
 });
 it("rejects stale or future-dated ticks", () => {
   expect(validateRelayTest({ ...quote, at:"2026-11-03T23:59:45Z" }, now)).toBeNull();
   expect(validateRelayTest({ ...quote, at:"2026-11-04T00:00:03Z" }, now)).toBeNull();
 });
 it("clears prices when the laptop is offline or the quote is stale", () => {
   const recent = "2026-11-03T23:59:55Z", old = "2026-11-03T23:59:30Z";
   expect(relayTestFresh(recent, recent, now)).toBe(true);
   expect(relayTestFresh(recent, null, now)).toBe(false);
   expect(relayTestFresh(old, recent, now)).toBe(false);
 });
});
