import { it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  options: null as any,
  closed: false,
}));
vi.mock("node:dns/promises", () => ({ lookup: state.lookup }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) {
      state.options = options;
    }
    async close() {
      state.closed = true;
    }
  },
  fetch: state.fetch,
}));
import { secureTransport } from "../server/ssrf";
it("pins public DNS answers into TLS lookup and forbids redirects/header forwarding", async () => {
  state.lookup.mockImplementationOnce(async () => {
    state.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  state.fetch.mockImplementation(async (_url, options) => {
    expect(options.redirect).toBe("error");
    const pinned = await new Promise((resolve) =>
      state.options.connect.lookup(
        "gateway.exness.com",
        { all: true },
        (_error: unknown, addresses: unknown) => resolve(addresses),
      ),
    );
    expect(pinned).toEqual([{ address: "93.184.216.34", family: 4 }]);
    return Response.json({ ok: true });
  });
  const response = await secureTransport(
    "https://gateway.exness.com/v1/trading/access-point?account_id=123",
    { redirect: "follow", headers: { "EXN-API-KEY": "synthetic-test-key" } },
  );
  expect(response.status).toBe(200);
  expect(state.lookup).toHaveBeenCalledTimes(1);
  expect(state.closed).toBe(true);
});
