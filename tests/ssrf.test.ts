import { describe, it, expect, vi } from "vitest";
import { safeOrigin, publicAddress, resolveHost } from "../server/ssrf";
describe("SSRF defenses", () => {
  it("allows only Exness domain boundaries, rejects URL ambiguity and non-HTTPS", () => {
    expect(safeOrigin("https://ap-123.exness.com")).toBe(
      "https://ap-123.exness.com",
    );
    for (const value of [
      "https://exness.com.evil.test",
      "https://evil-exness.com",
      "http://exness.com",
      "https://user@exness.com",
      "https://exness.com:444",
      "https://exness.com/#fragment",
      "https://exness.com/path",
      "https://localhost",
      "https://127.0.0.1",
    ])
      expect(() => safeOrigin(value)).toThrow();
  });
  it("rejects loopback, private, metadata, CGNAT, link local and IPv4-mapped IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "172.16.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("93.184.216.34")).toBe(true);
  });
  it("rejects DNS rebinding/mixed answers before any HTTP request", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolveHost("gateway.exness.com", resolver)).rejects.toThrow(
      "GATEWAY_NOT_ALLOWED",
    );
    await expect(
      resolveHost("gateway.exness.com", vi.fn().mockResolvedValue([])),
    ).rejects.toThrow();
  });
});
